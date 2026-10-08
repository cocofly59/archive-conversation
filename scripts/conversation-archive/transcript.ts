/**
 * Claude Code transcripts: JSON Lines written by Claude Code and by the desktop app's agent
 * sessions (Code and Cowork). One record per line; conversation turns are the `user` and
 * `assistant` records, and an assistant message is often split across several records that
 * share `message.id`.
 */
import { ArtifactStore } from "./artifacts.ts";
import type { Block, Conversation, Message, SourceFile } from "./types.ts";
import { collectReferences, isRecord, SourceError, str } from "./types.ts";

interface Boundary {
  readonly parent: string;
  readonly at: string | undefined;
}

interface Parsed {
  messages: Message[];
  firstAt: string | undefined;
  title: string | undefined;
  uuids: Set<string>;
  boundaries: Boundary[];
  dropped: Map<string, number>;
}

/**
 * The record ids a transcript holds and the ids its compactions point back to. A compaction
 * boundary names the last turn before it (`logicalParentUuid`); when no transcript holds that
 * id, the turns before the compaction are gone from the source.
 */
export function linkage(data: Uint8Array): { uuids: Set<string>; parents: Set<string> } {
  const uuids = new Set<string>();
  const parents = new Set<string>();
  for (const line of new TextDecoder().decode(data).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record: unknown = JSON.parse(line);
      if (!isRecord(record)) continue;
      const uuid = str(record["uuid"]);
      if (uuid !== undefined) uuids.add(uuid);
      const parent = str(record["logicalParentUuid"]);
      if (parent !== undefined && record["subtype"] === "compact_boundary") parents.add(parent);
    } catch {
      continue;
    }
  }
  return { uuids, parents };
}

/** True when a file name is a subagent transcript rather than a main conversation. */
export function isSubagentTranscript(name: string): boolean {
  return /(^|\/)subagents\//.test(name) || /(^|\/)agent-[^/]*\.jsonl$/.test(name);
}

export function parseTranscripts(files: readonly SourceFile[], diskFallback: boolean): Conversation {
  const main = files.filter((f) => !isSubagentTranscript(f.name));
  if (main.length === 0) throw new SourceError("no main transcript found (only subagent transcripts)");
  const warnings: string[] = [];
  const references = new Set<string>();
  const store = new ArtifactStore();
  const published = new Map<string, string>();
  const parsed = main
    .map((f) => parseOne(f, warnings, references, published))
    .sort((a, b) => (a.firstAt ?? "").localeCompare(b.firstAt ?? ""));
  const messages = parsed.flatMap((p) => p.messages);
  const known = new Set(parsed.flatMap((p) => [...p.uuids]));
  const gaps: string[] = [];
  for (const p of parsed) {
    for (const boundary of p.boundaries) {
      if (known.has(boundary.parent)) continue;
      const prompts = p.dropped.get(boundary.parent);
      gaps.push(`compacted${boundary.at !== undefined ? ` on ${boundary.at}` : ""}: ${prompts !== undefined ? `the ${prompts} earlier user prompts and their replies are` : "the earlier turns are"} not in the transcript, only the summary written at compaction`);
    }
  }
  if (messages.length === 0) throw new SourceError("the transcript holds no conversation messages");
  replayFileTools(messages, store);
  const artifacts = store.finish(diskFallback);
  warnings.push(...store.warnings);
  const subagents = files.length - main.length;
  if (subagents > 0) warnings.push(`${subagents} subagent transcript(s) kept in raw/ only, not rendered`);
  return {
    title: parsed.find((p) => p.title !== undefined)?.title ?? firstLine(messages),
    kind: "claude-code-transcript",
    startedAt: messages.find((m) => m.timestamp !== undefined)?.timestamp,
    endedAt: messages.findLast((m) => m.timestamp !== undefined)?.timestamp,
    messages,
    artifacts,
    attachments: [],
    raw: files.map((f) => ({ path: f.name, content: f.data, origin: "source" })),
    references: [...references],
    published: Object.fromEntries(published),
    gaps,
    warnings,
  };
}

function parseOne(file: SourceFile, warnings: string[], references: Set<string>, published: Map<string, string>): Parsed {
  const messages: Message[] = [];
  const uuids = new Set<string>();
  const boundaries: Boundary[] = [];
  const dropped = new Map<string, number>();
  let title: string | undefined;
  let lastAssistantId: string | undefined;
  let bad = 0;
  const lines = new TextDecoder().decode(file.data).split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      bad += 1;
      continue;
    }
    if (!isRecord(record)) continue;
    const type = record["type"];
    const uuid = str(record["uuid"]);
    if (uuid !== undefined) uuids.add(uuid);
    if (type === "frame-link") {
      const path = str(record["path"]);
      const url = str(record["frameUrl"]);
      if (path !== undefined && url !== undefined) published.set(url, path);
    }
    if (type === "system" && record["subtype"] === "compact_boundary") {
      const parent = str(record["logicalParentUuid"]);
      if (parent !== undefined) boundaries.push({ parent, at: str(record["timestamp"]) });
    }
    if (type === "custom-title") title = str(record["customTitle"]) ?? title;
    if (type === "summary") title ??= str(record["summary"]);
    const summary = type === "user" && record["isCompactSummary"] === true;
    if (summary) {
      const position = record["turnPosition"];
      const prompts = isRecord(position) ? position["promptIndex"] : undefined;
      const last = boundaries.at(-1);
      if (typeof prompts === "number" && last !== undefined) dropped.set(last.parent, prompts);
    }
    if ((type !== "user" && type !== "assistant") || record["isMeta"] === true || record["isSidechain"] === true) continue;
    const message = record["message"];
    if (!isRecord(message)) continue;
    const timestamp = str(record["timestamp"]);
    const blocks = toBlocks(message["content"]);
    if (blocks.length === 0) continue;
    collectReferences(message["content"], references);
    if (type === "assistant") {
      const id = str(message["id"]);
      const last = messages.at(-1);
      if (last !== undefined && last.role === "assistant" && id !== undefined && id === lastAssistantId) {
        last.blocks.push(...blocks);
        continue;
      }
      lastAssistantId = id;
    } else {
      lastAssistantId = undefined;
    }
    messages.push(summary ? { role: type, timestamp, summary, blocks } : { role: type, timestamp, blocks });
  }
  if (bad > 0) warnings.push(`${file.name}: ${bad} unreadable line(s) skipped`);
  return { messages, firstAt: messages[0]?.timestamp, title, uuids, boundaries, dropped };
}

function toBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content.trim() === "" ? [] : [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    switch (item["type"]) {
      case "text": {
        const text = str(item["text"]);
        if (text !== undefined && text.trim() !== "") blocks.push({ kind: "text", text });
        break;
      }
      case "thinking": {
        const text = str(item["thinking"]);
        if (text !== undefined && text.trim() !== "") blocks.push({ kind: "thinking", text });
        break;
      }
      case "tool_use":
        blocks.push({ kind: "tool_call", id: str(item["id"]) ?? "", name: str(item["name"]) ?? "unknown", input: item["input"] });
        break;
      case "tool_result":
        blocks.push({
          kind: "tool_result",
          id: str(item["tool_use_id"]) ?? "",
          content: resultText(item["content"]),
          isError: item["is_error"] === true,
        });
        break;
      case "image":
      case "document":
        blocks.push({ kind: "attachment", name: String(item["type"]), archived: false });
        break;
    }
  }
  return blocks;
}

/** Flattens a tool result to text; non-text parts are named, not inlined. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      const text = str(part["text"]);
      if (text !== undefined) return text;
      return `[${String(part["type"])}]`;
    })
    .join("\n");
}

/** Collects the ids of tool calls whose result was an error: those calls changed nothing. */
export function failedCalls(messages: readonly Message[]): Set<string> {
  const failed = new Set<string>();
  for (const message of messages) {
    for (const block of message.blocks) if (block.kind === "tool_result" && block.isError) failed.add(block.id);
  }
  return failed;
}

function replayFileTools(messages: readonly Message[], store: ArtifactStore): void {
  const failed = failedCalls(messages);
  const blocks = messages.flatMap((m) => m.blocks);
  for (const block of blocks) {
    if (block.kind !== "tool_call" || failed.has(block.id) || !isRecord(block.input)) continue;
    const input = block.input;
    const path = str(input["file_path"]);
    if (path === undefined) continue;
    const origin = `tool ${block.name}`;
    if (block.name === "Write") {
      const content = str(input["content"]);
      if (content !== undefined) store.write(path, content, origin);
    } else if (block.name === "Edit") {
      applyEdit(store, path, input, origin);
    } else if (block.name === "MultiEdit" && Array.isArray(input["edits"])) {
      for (const edit of input["edits"]) if (isRecord(edit)) applyEdit(store, path, edit, origin);
    }
  }
}

function applyEdit(store: ArtifactStore, path: string, edit: Record<string, unknown>, origin: string): void {
  const oldText = str(edit["old_string"]);
  const newText = str(edit["new_string"]);
  if (oldText === undefined || newText === undefined) return;
  store.replace(path, oldText, newText, edit["replace_all"] === true, origin);
}

function firstLine(messages: readonly Message[]): string {
  for (const message of messages) {
    if (message.role !== "user" || message.summary === true) continue;
    for (const block of message.blocks) {
      if (block.kind === "text") return block.text.trim().split("\n")[0]?.slice(0, 80) ?? "conversation";
    }
  }
  return "conversation";
}
