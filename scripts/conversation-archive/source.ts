import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { conversationsOf, parseConversation, select } from "./claudeai.ts";
import { parseTranscripts } from "./transcript.ts";
import type { Conversation, SourceFile } from "./types.ts";
import { collectReferences, SourceError } from "./types.ts";
import { readZip } from "./zip.ts";

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** Reads every regular file under a directory, names relative to it. */
export function readTree(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        files.push({ name: relative(root, path).split("\\").join("/"), data: readFileSync(path) });
      }
    }
  };
  walk(root);
  return files;
}

function readSet(path: string): SourceFile[] {
  if (statSync(path).isDirectory()) return readTree(path);
  return readZip(readFileSync(path));
}

/** Loads a list of conversations held by a claude.ai export, for the `list` command. */
export function loadExport(path: string): Record<string, unknown>[] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return conversationsOf(JSON.parse(readFileSync(path, "utf8")));
  const exported = readSet(path).find((f) => basename(f.name) === "conversations.json");
  if (exported === undefined) throw new SourceError(`${path} holds no conversations.json`);
  return conversationsOf(JSON.parse(new TextDecoder().decode(exported.data)));
}

/**
 * Detects the source shape and parses it:
 * - `.jsonl`: one Claude Code transcript;
 * - `.json`: a claude.ai export or a single conversation from it;
 * - `.md` / `.txt`: a conversation pasted as text, or reconstructed by the assistant, kept verbatim;
 * - directory or `.zip`: a claude.ai export when it holds `conversations.json`, otherwise the
 *   Claude Code transcripts (`*.jsonl`) it holds, such as an app session export.
 */
export function loadSource(path: string, selector: string | undefined, title: string | undefined, reconstructed = false): Conversation {
  const lower = path.toLowerCase();
  const name = basename(path);
  if (lower.endsWith(".jsonl")) return parseTranscripts([{ name, data: readFileSync(path) }], true);
  if (lower.endsWith(".json")) return parseConversation(select(conversationsOf(JSON.parse(readFileSync(path, "utf8"))), selector));
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return pasted(path, title, reconstructed);
  const isDir = statSync(path).isDirectory();
  if (!isDir && !lower.endsWith(".zip")) throw new SourceError(`unsupported source ${name}: expected .jsonl, .json, .md, .txt, .zip or a folder`);
  const files = readSet(path);
  const exported = files.find((f) => basename(f.name) === "conversations.json");
  if (exported !== undefined) {
    return parseConversation(select(conversationsOf(JSON.parse(new TextDecoder().decode(exported.data))), selector));
  }
  const transcripts = files.filter((f) => extname(f.name) === ".jsonl");
  if (transcripts.length === 0) throw new SourceError(`${name} holds neither conversations.json nor any .jsonl transcript`);
  return parseTranscripts(transcripts, isDir);
}

function pasted(path: string, title: string | undefined, reconstructed: boolean): Conversation {
  const text = readFileSync(path, "utf8");
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const references = new Set<string>();
  collectReferences(text, references);
  return {
    title: title ?? heading ?? basename(path, extname(path)),
    kind: reconstructed ? "reconstructed" : "markdown",
    messages: [],
    artifacts: [],
    attachments: [],
    raw: [{ path: basename(path), content: text, origin: "source" }],
    references: [...references],
    warnings: [
      reconstructed
        ? "reconstructed: written by the assistant from its own context, not read from a transcript; turns lost to context compaction are missing"
        : "pasted text: kept verbatim as conversation.md; roles and artifacts are not parsed",
    ],
  };
}
