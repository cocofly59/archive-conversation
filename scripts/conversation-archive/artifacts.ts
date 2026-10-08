import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import type { ArchivedFile } from "./types.ts";

interface Entry {
  content: string | undefined;
  versions: number;
  origin: string;
}

/**
 * Replays the file operations of a conversation (whole writes and string replacements) to
 * recover the last version of every file it produced. Keys are absolute paths or artifact ids.
 */
export class ArtifactStore {
  private readonly entries = new Map<string, Entry>();
  readonly warnings: string[] = [];

  write(key: string, content: string, origin: string): void {
    const entry = this.entries.get(key);
    this.entries.set(key, { content, versions: (entry?.versions ?? 0) + 1, origin });
  }

  replace(key: string, oldText: string, newText: string, all: boolean, origin: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.content === undefined) {
      this.entries.set(key, { content: undefined, versions: (entry?.versions ?? 0) + 1, origin: entry?.origin ?? origin });
      return;
    }
    const at = entry.content.indexOf(oldText);
    if (at < 0) {
      this.warnings.push(`${key}: an edit did not apply (text to replace not found); later edits may be off`);
      return;
    }
    entry.content = all
      ? entry.content.split(oldText).join(newText)
      : entry.content.slice(0, at) + newText + entry.content.slice(at + oldText.length);
    entry.versions += 1;
  }

  /**
   * Returns the recovered files with archive-relative paths. A file edited but never written in
   * full is read from disk when `diskFallback` is set and the path exists, otherwise reported.
   */
  finish(diskFallback: boolean): ArchivedFile[] {
    const keys = [...this.entries.keys()];
    const rename = relativePaths(keys);
    const files: ArchivedFile[] = [];
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry === undefined) continue;
      let content: string | Uint8Array | undefined = entry.content;
      if (content === undefined) {
        if (diskFallback && key.startsWith("/") && existsSync(key)) {
          content = readFileSync(key);
          this.warnings.push(`${key}: edited but never written in full in the conversation; taken from disk as it is now`);
        } else {
          this.warnings.push(`${key}: edited but never written in full in the conversation; content not recoverable`);
          continue;
        }
      }
      files.push({ path: rename.get(key) ?? safePath(key), content, origin: entry.origin, versions: entry.versions });
    }
    return files;
  }
}

/** Strips the longest common directory of absolute keys; other keys are only sanitized. */
export function relativePaths(keys: readonly string[]): Map<string, string> {
  const absolute = keys.filter((k) => k.startsWith("/"));
  const result = new Map<string, string>();
  let common: string[] | undefined;
  for (const key of absolute) {
    const dirs = posix.dirname(key).split("/");
    if (common === undefined) {
      common = dirs;
      continue;
    }
    let i = 0;
    while (i < common.length && i < dirs.length && common[i] === dirs[i]) i += 1;
    common = common.slice(0, i);
  }
  const prefix = common === undefined ? "" : common.join("/");
  for (const key of keys) {
    const relative = key.startsWith("/") ? key.slice(prefix.length) : key;
    result.set(key, safePath(relative));
  }
  return result;
}

/** Turns any key into a relative POSIX path with no empty, `.` or `..` segment. */
export function safePath(path: string): string {
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((p) => p !== "" && p !== "." && p !== "..")
    .map((p) => p.replace(/[\x00-\x1f:*?"<>|]/g, "_"));
  return parts.length === 0 ? "unnamed" : parts.join("/");
}
