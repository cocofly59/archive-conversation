import type { Reference } from "./pack.ts";
import type { Block, Conversation } from "./types.ts";

const LIMIT = 4000;

function fence(text: string, info = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${info}\n${text.replace(/\n$/, "")}\n${marks}`;
}

function clip(text: string): string {
  if (text.length <= LIMIT) return text;
  return `${text.slice(0, LIMIT)}\n[... ${text.length - LIMIT} more characters, see conversation.json]`;
}

function toolLabel(name: string, input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ["file_path", "path", "command", "url", "title", "description", "query"]) {
      const value = record[key];
      if (typeof value === "string") return `${name}: ${value.split("\n")[0]?.slice(0, 100) ?? ""}`;
    }
  }
  return name;
}

function renderBlock(block: Block): string | undefined {
  switch (block.kind) {
    case "text":
      return block.text.trim();
    case "thinking":
      return undefined;
    case "tool_call":
      return `<details><summary>Tool call · ${escapeHtml(toolLabel(block.name, block.input))}</summary>\n\n${fence(clip(JSON.stringify(block.input, null, 2) ?? ""), "json")}\n\n</details>`;
    case "tool_result":
      return `<details><summary>${block.isError ? "Tool error" : "Tool result"}</summary>\n\n${fence(clip(block.content))}\n\n</details>`;
    case "attachment":
      return `*Attachment: ${block.name}${block.archived ? " (in attachments/)" : " (not in the archive)"}*`;
  }
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Renders the conversation as Markdown for a human or an agent to read in order. */
export function renderMarkdown(conversation: Conversation, references: readonly Reference[] = conversation.references.map((url) => ({ url, archived: null }))): string {
  const lines: string[] = [`# ${conversation.title}`, ""];
  lines.push(`- Source: ${conversation.kind}`);
  if (conversation.startedAt !== undefined) lines.push(`- Period: ${conversation.startedAt} to ${conversation.endedAt ?? "?"}`);
  lines.push(`- Messages: ${conversation.messages.length}`);
  if (conversation.artifacts.length > 0) {
    lines.push("- Artifacts (last version, in artifacts/):");
    for (const artifact of conversation.artifacts) lines.push(`  - \`${artifact.path}\``);
  }
  if (conversation.gaps.length > 0) {
    lines.push("- Incomplete:");
    for (const gap of conversation.gaps) lines.push(`  - ${gap}`);
  }
  if (references.length > 0) {
    lines.push("- Published artifacts and documents referenced:");
    for (const r of references) lines.push(`  - ${r.url}${r.archived !== null ? ` (in \`${r.archived}\`)` : " (not in the archive)"}`);
  }
  lines.push("");
  for (const message of conversation.messages) {
    const parts = message.blocks.map(renderBlock).filter((p): p is string => p !== undefined && p !== "");
    if (parts.length === 0) continue;
    const onlyResults = message.blocks.every((b) => b.kind === "tool_result");
    if (!onlyResults) {
      const role = message.summary === true ? "Summary of earlier turns (written at compaction)" : message.role === "user" ? "User" : "Assistant";
      lines.push("---", "", `## ${role}${message.timestamp !== undefined ? ` · ${message.timestamp}` : ""}`, "");
    }
    for (const part of parts) lines.push(part, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
