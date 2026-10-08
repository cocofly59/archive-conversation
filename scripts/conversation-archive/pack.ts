import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { safePath } from "./artifacts.ts";
import { renderMarkdown } from "./render.ts";
import { findSecrets } from "./secrets.ts";
import { readTree } from "./source.ts";
import type { TarEntry } from "./tar.ts";
import type { ArchivedFile, Conversation } from "./types.ts";

export const FORMAT = "conversation-archive/1";

/** The plugin's version, read from its manifest next to the scripts; "unknown" when unreadable. */
export function pluginVersion(): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
    const version = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>)["version"] : undefined;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

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
  readonly packer: { readonly name: "archive-conversation"; readonly version: string };
  readonly title: string;
  readonly source: { readonly kind: string; readonly name: string };
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly packedAt: string;
  readonly messages: number;
  readonly files: ManifestFile[];
  readonly references: Reference[];
  readonly gaps: string[];
  readonly warnings: string[];
}

/** A published artifact or document link from the conversation, and where its content is in the archive. */
export interface Reference {
  readonly url: string;
  readonly archived: string | null;
}

/** Included files, and the published links some of them stand for (`--include URL=PATH`). */
export interface Included {
  readonly files: ArchivedFile[];
  readonly links: Map<string, string>;
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

/** Splits `URL=PATH` into its parts; a plain path has no URL. */
export function parseInclude(value: string): { url: string | undefined; path: string } {
  const match = /^(https?:\/\/[^=\s]+)=(.+)$/.exec(value);
  return match?.[1] !== undefined && match[2] !== undefined ? { url: match[1], path: match[2] } : { url: undefined, path: value };
}

/**
 * Reads `--include` values: a file keeps its base name, a folder keeps its inner layout. A value
 * `URL=PATH` also records that PATH holds the content published at URL. A path given twice is read once.
 */
export function readIncludes(values: readonly string[]): Included {
  const files: ArchivedFile[] = [];
  const links = new Map<string, string>();
  const read = new Map<string, string>();
  for (const value of values) {
    const { url, path } = parseInclude(value);
    const key = resolve(path);
    let archived = read.get(key);
    if (archived === undefined) {
      if (statSync(path).isDirectory()) {
        for (const file of readTree(path)) files.push({ path: safePath(file.name), content: file.data, origin: `included from ${basename(path)}/` });
        archived = "artifacts/";
      } else {
        archived = `artifacts/${safePath(basename(path))}`;
        files.push({ path: safePath(basename(path)), content: readFileSync(path), origin: url === undefined ? "included" : `included for ${url}` });
      }
      read.set(key, archived);
    }
    if (url !== undefined) links.set(url, archived);
  }
  return { files, links };
}

/**
 * Says where each referenced link's content is in the archive: an explicit `--include URL=PATH`
 * first, then the file the session published at that link, matched by its trailing path.
 */
export function resolveReferences(urls: readonly string[], published: Record<string, string>, links: ReadonlyMap<string, string>, artifacts: readonly ArchivedFile[]): Reference[] {
  return urls.map((url) => {
    const explicit = links.get(url);
    if (explicit !== undefined) return { url, archived: explicit };
    const source = published[url];
    if (source === undefined) return { url, archived: null };
    const parts = source.split("/").filter(Boolean);
    for (let n = parts.length; n >= 1; n -= 1) {
      const tail = parts.slice(-n).join("/");
      const match = artifacts.find((a) => a.path === tail || a.path.endsWith(`/${tail}`));
      if (match !== undefined) return { url, archived: `artifacts/${match.path}` };
    }
    return { url, archived: null };
  });
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
export function pack(conversation: Conversation, sourceName: string, included: Included, packedAt: Date): Packed {
  const warnings = [...conversation.warnings];
  const artifacts = mergeArtifacts(conversation.artifacts, included.files, warnings);
  const references = resolveReferences(conversation.references, conversation.published, included.links, artifacts);
  const root = `${(conversation.startedAt ?? packedAt.toISOString()).slice(0, 10)}-${slugify(conversation.title)}`;
  const markdown = (conversation.kind === "markdown" || conversation.kind === "reconstructed") && conversation.raw[0] !== undefined
    ? String(conversation.raw[0].content)
    : renderMarkdown({ ...conversation, artifacts }, references);
  const json = JSON.stringify(
    {
      title: conversation.title,
      kind: conversation.kind,
      startedAt: conversation.startedAt,
      endedAt: conversation.endedAt,
      messages: conversation.messages,
      artifacts: artifacts.map((a) => ({ path: `artifacts/${a.path}`, origin: a.origin, versions: a.versions })),
      references,
      gaps: conversation.gaps,
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
    packer: { name: "archive-conversation", version: pluginVersion() },
    title: conversation.title,
    source: { kind: conversation.kind, name: sourceName },
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    packedAt: packedAt.toISOString(),
    messages: conversation.messages.length,
    files: files.map(({ path, role, file }) => describe(path, role, file)),
    references,
    gaps: conversation.gaps,
    warnings,
  };
  const entries: TarEntry[] = [
    { path: `${root}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...files.map(({ path, file }) => ({ path: `${root}/${path}`, content: file.content })),
  ];
  return { root, entries, manifest };
}
