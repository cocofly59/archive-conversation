import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { safePath } from "./artifacts.ts";
import { renderMarkdown } from "./render.ts";
import { findSecrets } from "./secrets.ts";
import { readTree } from "./source.ts";
import type { TarEntry } from "./tar.ts";
import type { ArchivedFile, Conversation } from "./types.ts";

export const FORMAT = "conversation-archive/1";

export interface ManifestFile {
  readonly path: string;
  readonly role: "conversation" | "artifact" | "attachment" | "raw";
  readonly origin: string;
  readonly versions?: number | undefined;
  readonly bytes: number;
  readonly sha256: string;
}

export interface Manifest {
  readonly format: typeof FORMAT;
  readonly title: string;
  readonly source: { readonly kind: string; readonly name: string };
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly packedAt: string;
  readonly messages: number;
  readonly files: ManifestFile[];
  readonly references: string[];
  readonly warnings: string[];
}

/** Lowercase ASCII slug, at most 60 characters. */
export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug === "" ? "conversation" : slug;
}

/** Reads `--include` paths: a file keeps its base name, a folder keeps its inner layout. */
export function readIncludes(paths: readonly string[]): ArchivedFile[] {
  const files: ArchivedFile[] = [];
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      for (const file of readTree(path)) files.push({ path: safePath(file.name), content: file.data, origin: `included from ${basename(path)}/` });
    } else {
      files.push({ path: safePath(basename(path)), content: readFileSync(path), origin: "included" });
    }
  }
  return files;
}

/** Merges included files over the recovered artifacts: an included file wins on a path clash. */
export function mergeArtifacts(recovered: readonly ArchivedFile[], included: readonly ArchivedFile[], warnings: string[]): ArchivedFile[] {
  const byPath = new Map(recovered.map((f) => [f.path, f]));
  for (const file of included) {
    if (byPath.has(file.path)) warnings.push(`artifacts/${file.path}: included file replaces the version recovered from the conversation`);
    byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

function describe(path: string, role: ManifestFile["role"], file: { content: string | Uint8Array; origin: string; versions?: number | undefined }): ManifestFile {
  const bytes = bytesOf(file.content);
  return {
    path,
    role,
    origin: file.origin,
    ...(file.versions !== undefined ? { versions: file.versions } : {}),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export interface Packed {
  readonly root: string;
  readonly entries: TarEntry[];
  readonly manifest: Manifest;
}

/** Lays out the archive: conversation.md and .json, artifacts/, attachments/, raw/, manifest.json. */
export function pack(conversation: Conversation, sourceName: string, included: readonly ArchivedFile[], packedAt: Date): Packed {
  const warnings = [...conversation.warnings];
  const artifacts = mergeArtifacts(conversation.artifacts, included, warnings);
  const root = `${(conversation.startedAt ?? packedAt.toISOString()).slice(0, 10)}-${slugify(conversation.title)}`;
  const markdown = (conversation.kind === "markdown" || conversation.kind === "reconstructed") && conversation.raw[0] !== undefined
    ? String(conversation.raw[0].content)
    : renderMarkdown({ ...conversation, artifacts });
  const json = JSON.stringify(
    {
      title: conversation.title,
      kind: conversation.kind,
      startedAt: conversation.startedAt,
      endedAt: conversation.endedAt,
      messages: conversation.messages,
      artifacts: artifacts.map((a) => ({ path: `artifacts/${a.path}`, origin: a.origin, versions: a.versions })),
      references: conversation.references,
    },
    null,
    2,
  );
  const files: { path: string; role: ManifestFile["role"]; file: ArchivedFile }[] = [
    { path: "conversation.md", role: "conversation", file: { path: "", content: markdown, origin: "rendered" } },
    { path: "conversation.json", role: "conversation", file: { path: "", content: json, origin: "normalized" } },
    ...artifacts.map((f) => ({ path: `artifacts/${f.path}`, role: "artifact" as const, file: f })),
    ...conversation.attachments.map((f) => ({ path: `attachments/${f.path}`, role: "attachment" as const, file: f })),
    ...conversation.raw.map((f) => ({ path: `raw/${safePath(f.path)}`, role: "raw" as const, file: f })),
  ];
  const decoder = new TextDecoder();
  for (const { path, role, file } of files) {
    if (role === "conversation" && path.endsWith(".json")) continue;
    const kinds = findSecrets(decoder.decode(bytesOf(file.content)));
    if (kinds.length > 0) warnings.push(`${path}: possible secret (${kinds.join(", ")}); review before sharing or committing`);
  }
  const manifest: Manifest = {
    format: FORMAT,
    title: conversation.title,
    source: { kind: conversation.kind, name: sourceName },
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    packedAt: packedAt.toISOString(),
    messages: conversation.messages.length,
    files: files.map(({ path, role, file }) => describe(path, role, file)),
    references: conversation.references,
    warnings,
  };
  const entries: TarEntry[] = [
    { path: `${root}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...files.map(({ path, file }) => ({ path: `${root}/${path}`, content: file.content })),
  ];
  return { root, entries, manifest };
}
