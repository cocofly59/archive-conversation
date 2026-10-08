/**
 * claude.ai data exports: `conversations.json` holds an array of conversations, each with
 * `chat_messages` whose `content` blocks carry text, thinking, and tool calls. Artifacts are
 * rebuilt by replaying the `artifacts` tool (create, update, rewrite) and the file tools
 * (`create_file`, `str_replace`).
 */
import { ArtifactStore, safePath } from "./artifacts.ts";
import { failedCalls, resultText } from "./transcript.ts";
import type { ArchivedFile, Block, Conversation, Message } from "./types.ts";
import { collectReferences, isRecord, SourceError, str } from "./types.ts";

export interface ConversationSummary {
  readonly uuid: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly messages: number;
}

/** Accepts the export's array, a single conversation object, or `{ conversations: [...] }`. */
export function conversationsOf(json: unknown): Record<string, unknown>[] {
  const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json["conversations"]) ? json["conversations"] : [json];
  const conversations = list.filter((c): c is Record<string, unknown> => isRecord(c) && Array.isArray(c["chat_messages"]));
  if (conversations.length === 0) throw new SourceError("no claude.ai conversation (an object with chat_messages) found");
  return conversations;
}

export function summarize(conversations: readonly Record<string, unknown>[]): ConversationSummary[] {
  return conversations
    .map((c) => ({
      uuid: str(c["uuid"]) ?? "",
      name: str(c["name"]) ?? "",
      updatedAt: str(c["updated_at"]) ?? "",
      messages: Array.isArray(c["chat_messages"]) ? c["chat_messages"].length : 0,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Picks one conversation by uuid, uuid prefix, or case-insensitive name substring. */
export function select(conversations: readonly Record<string, unknown>[], selector: string | undefined): Record<string, unknown> {
  if (selector === undefined) {
    const only = conversations[0];
    if (conversations.length === 1 && only !== undefined) return only;
    throw new SourceError(`the export holds ${conversations.length} conversations; choose one with --conversation (run "list" to see them)`);
  }
  const needle = selector.toLowerCase();
  const exact = conversations.filter((c) => str(c["uuid"]) === selector);
  const matches = exact.length > 0
    ? exact
    : conversations.filter((c) => (str(c["uuid"]) ?? "").startsWith(selector) || (str(c["name"]) ?? "").toLowerCase().includes(needle));
  const match = matches[0];
  if (matches.length === 1 && match !== undefined) return match;
  if (matches.length === 0) throw new SourceError(`no conversation matches "${selector}"`);
  const names = summarize(matches).map((s) => `  ${s.uuid}  ${s.name}`).join("\n");
  throw new SourceError(`"${selector}" matches ${matches.length} conversations; use the uuid:\n${names}`);
}

const EXTENSIONS: Record<string, string> = {
  "text/markdown": ".md",
  "text/html": ".html",
  "image/svg+xml": ".svg",
  "application/vnd.ant.react": ".jsx",
  "application/vnd.ant.mermaid": ".mmd",
  "text/plain": ".txt",
};

const LANGUAGES: Record<string, string> = {
  typescript: ".ts", javascript: ".js", python: ".py", tsx: ".tsx", jsx: ".jsx", html: ".html", css: ".css",
  json: ".json", sql: ".sql", bash: ".sh", shell: ".sh", yaml: ".yaml", markdown: ".md", go: ".go", rust: ".rs",
  java: ".java", kotlin: ".kt", swift: ".swift", ruby: ".rb", php: ".php", csharp: ".cs", c: ".c", cpp: ".cpp",
};

function artifactName(input: Record<string, unknown>, id: string): string {
  const type = str(input["type"]) ?? "";
  const language = (str(input["language"]) ?? "").toLowerCase();
  const ext = EXTENSIONS[type] ?? LANGUAGES[language] ?? ".txt";
  return id.endsWith(ext) ? id : `${id}${ext}`;
}

export function parseConversation(conversation: Record<string, unknown>): Conversation {
  const references = new Set<string>();
  const store = new ArtifactStore();
  const artifactKeys = new Map<string, string>();
  const attachments: ArchivedFile[] = [];
  const warnings: string[] = [];
  const messages: Message[] = [];
  const chat = Array.isArray(conversation["chat_messages"]) ? conversation["chat_messages"] : [];
  for (const raw of chat) {
    if (!isRecord(raw)) continue;
    const role = raw["sender"] === "human" ? "user" : "assistant";
    const blocks = toBlocks(raw);
    collectReferences(raw["content"] ?? raw["text"], references);
    for (const attachment of Array.isArray(raw["attachments"]) ? raw["attachments"] : []) {
      if (!isRecord(attachment)) continue;
      const name = str(attachment["file_name"]) ?? `attachment-${attachments.length + 1}`;
      const text = str(attachment["extracted_content"]);
      if (text !== undefined) attachments.push({ path: safePath(name), content: text, origin: "attachment (extracted text)" });
      blocks.push({ kind: "attachment", name, archived: text !== undefined });
    }
    for (const file of Array.isArray(raw["files"]) ? raw["files"] : []) {
      const name = isRecord(file) ? (str(file["file_name"]) ?? "file") : "file";
      blocks.push({ kind: "attachment", name, archived: false });
      warnings.push(`${name}: uploaded file not included in the export; add it with --include`);
    }
    if (blocks.length > 0) messages.push({ role, timestamp: str(raw["created_at"]), blocks });
  }
  if (messages.length === 0) throw new SourceError("the conversation holds no messages");
  const failed = failedCalls(messages);
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "tool_call" && (block.id === "" || !failed.has(block.id))) replay(block, store, artifactKeys);
    }
  }
  const artifacts = store.finish(false);
  warnings.push(...store.warnings);
  return {
    title: str(conversation["name"])?.trim() || "conversation",
    kind: "claude-ai-export",
    startedAt: str(conversation["created_at"]) ?? messages[0]?.timestamp,
    endedAt: str(conversation["updated_at"]) ?? messages.at(-1)?.timestamp,
    messages,
    artifacts,
    attachments,
    raw: [{ path: "conversation.json", content: JSON.stringify(conversation, null, 2), origin: "source" }],
    references: [...references],
    published: {},
    gaps: [],
    warnings,
  };
}

function toBlocks(message: Record<string, unknown>): Block[] {
  const content = message["content"];
  if (!Array.isArray(content) || content.length === 0) {
    const text = str(message["text"]);
    return text === undefined || text.trim() === "" ? [] : [{ kind: "text", text }];
  }
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
        blocks.push({ kind: "tool_result", id: str(item["tool_use_id"]) ?? "", content: resultText(item["content"]), isError: item["is_error"] === true });
        break;
    }
  }
  return blocks;
}

function replay(block: Extract<Block, { kind: "tool_call" }>, store: ArtifactStore, keys: Map<string, string>): void {
  if (!isRecord(block.input)) return;
  const input = block.input;
  if (block.name === "artifacts") {
    const id = str(input["id"]);
    if (id === undefined) return;
    let key = keys.get(id);
    if (key === undefined) {
      key = artifactName(input, id);
      keys.set(id, key);
    }
    const command = str(input["command"]);
    const content = str(input["content"]);
    if ((command === "create" || command === "rewrite") && content !== undefined) store.write(key, content, "artifact");
    if (command === "update") {
      const oldText = str(input["old_str"]);
      const newText = str(input["new_str"]);
      if (oldText !== undefined && newText !== undefined) store.replace(key, oldText, newText, false, "artifact");
    }
    return;
  }
  const path = str(input["path"]);
  if (path === undefined) return;
  if (block.name === "create_file") {
    const text = str(input["file_text"]);
    if (text !== undefined) store.write(path, text, `tool ${block.name}`);
  } else if (block.name === "str_replace") {
    const oldText = str(input["old_str"]);
    const newText = str(input["new_str"]);
    if (oldText !== undefined && newText !== undefined) store.replace(path, oldText, newText, false, `tool ${block.name}`);
  }
}
