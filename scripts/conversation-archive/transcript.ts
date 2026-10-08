/**
 * Claude Code transcripts: JSON Lines written by Claude Code and by the desktop app's agent
 * sessions (Code and Cowork). One record per line; conversation turns are the `user` and
 * `assistant` records, and an assistant message is often split across several records that
 * share `message.id`.
 */
import { ArtifactStore } from "./artifacts.ts";
import type { Block, Conversation, Message, SourceFile } from "./types.ts";
import { collectReferences, isRecord, SourceError, str } from "./types.ts";

interface Parsed {
  messages: Message[];
  firstAt: string | undefined;
  title: string | undefined;
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
  const parsed = main
    .map((f) => parseOne(f, warnings, references))
    .sort((a, b) => (a.firstAt ?? "").localeCompare(b.firstAt ?? ""));
  const messages = parsed.flatMap((p) => p.messages);
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
    warnings,
  };
}

function parseOne(file: SourceFile, warnings: string[], references: Set<string>): Parsed {
  const messages: Message[] = [];
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
    if (type === "custom-title") title = str(record["customTitle"]) ?? title;
    if (type === "summary") title ??= str(record["summary"]);
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
    messages.push({ role: type, timestamp, blocks });
  }
  if (bad > 0) warnings.push(`${file.name}: ${bad} unreadable line(s) skipped`);
  return { messages, firstAt: messages[0]?.timestamp, title };
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
    if (message.role !== "user") continue;
    for (const block of message.blocks) {
      if (block.kind === "text") return block.text.trim().split("\n")[0]?.slice(0, 80) ?? "conversation";
    }
  }
  return "conversation";
}
