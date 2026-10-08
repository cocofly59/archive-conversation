/** `reconstructed`: written by the assistant from its own context, where no transcript file exists. */
export type SourceKind = "claude-code-transcript" | "claude-ai-export" | "markdown" | "reconstructed";

export type Role = "user" | "assistant";

export type Block =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool_call"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "tool_result"; readonly id: string; readonly content: string; readonly isError: boolean }
  | { readonly kind: "attachment"; readonly name: string; readonly archived: boolean };

export interface Message {
  readonly role: Role;
  readonly timestamp?: string | undefined;
  /** True for the summary a compaction wrote in place of the earlier turns. */
  readonly summary?: boolean | undefined;
  readonly blocks: Block[];
}

/** A file stored in the archive. `path` is relative to its section (artifacts/, attachments/ or raw/). */
export interface ArchivedFile {
  readonly path: string;
  readonly content: string | Uint8Array;
  readonly origin: string;
  readonly versions?: number | undefined;
}

export interface Conversation {
  readonly title: string;
  readonly kind: SourceKind;
  readonly startedAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly messages: Message[];
  readonly artifacts: ArchivedFile[];
  readonly attachments: ArchivedFile[];
  readonly raw: ArchivedFile[];
  /** Published artifact or document links found in the conversation; their content is not in the source. */
  readonly references: string[];
  /** Published artifact link -> path of the file the session published there, when the source records it. */
  readonly published: Record<string, string>;
  /** Parts of the conversation the source no longer holds, such as turns dropped at a compaction. */
  readonly gaps: string[];
  readonly warnings: string[];
}

/** A source file read from disk or from a zip, with a name relative to the source root. */
export interface SourceFile {
  readonly name: string;
  readonly data: Uint8Array;
}

export class SourceError extends Error {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const REFERENCE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+/g;

/** Collects published artifact links mentioned anywhere in a value. */
export function collectReferences(value: unknown, into: Set<string>): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return;
  for (const match of text.matchAll(REFERENCE)) into.add(match[0]);
}
