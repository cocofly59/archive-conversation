import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { summarize } from "./claudeai.ts";
import { pack, readIncludes } from "./pack.ts";
import { loadExport, loadSource } from "./source.ts";
import { tarGzip } from "./tar.ts";
import { SourceError } from "./types.ts";

export const EXIT_OK = 0;
export const EXIT_SOURCE = 1;
export const EXIT_USAGE = 2;

const USAGE = `Usage:
  conversation-archive.ts pack SOURCE [--out FILE] [--conversation UUID|NAME] [--include PATH]...
                               [--title TITLE] [--force]
  conversation-archive.ts list SOURCE

pack  Normalize one conversation and the artifacts it produced into a .tar.gz archive holding
      manifest.json, conversation.md, conversation.json, artifacts/, attachments/ and raw/.
      SOURCE is a Claude Code or desktop session transcript (.jsonl), a session export or
      session folder (.zip or folder of .jsonl), a claude.ai data export (.zip, folder, or
      conversations.json), or a conversation pasted as text (.md, .txt).
      --include adds files the source does not contain (published artifacts, an outputs folder);
      it may be repeated. --out defaults to ./<date>-<title-slug>.tar.gz.
list  List the conversations of a claude.ai data export, most recent first.

Exit codes: 0 ok, 1 unreadable or ambiguous source, 2 usage error.
`;

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function runPack(args: readonly string[], io: Io, now: Date): number {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      out: { type: "string" },
      conversation: { type: "string" },
      include: { type: "string", multiple: true, default: [] },
      title: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const source = positionals[0];
  if (source === undefined || positionals.length > 1) {
    io.stderr(`pack takes exactly one SOURCE\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  for (const path of [source, ...values.include]) {
    if (!existsSync(path)) {
      io.stderr(`not found: ${path}\n`);
      return EXIT_USAGE;
    }
  }
  const loaded = loadSource(resolve(source), values.conversation, values.title);
  const conversation = values.title === undefined ? loaded : { ...loaded, title: values.title };
  const packed = pack(conversation, basename(source), readIncludes(values.include), now);
  const out = resolve(values.out ?? `${packed.root}.tar.gz`);
  if (existsSync(out) && !values.force) {
    io.stderr(`${out} already exists; pass --force to overwrite\n`);
    return EXIT_USAGE;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, tarGzip(packed.entries, new Date(conversation.endedAt ?? now.toISOString())));
  const { manifest } = packed;
  const count = (role: string): number => manifest.files.filter((f) => f.role === role).length;
  const lines = [
    `archive: ${out}`,
    `root folder: ${packed.root}/`,
    `title: ${manifest.title}`,
    `source: ${manifest.source.kind} (${manifest.source.name})`,
    `messages: ${manifest.messages}, artifacts: ${count("artifact")}, attachments: ${count("attachment")}, raw files: ${count("raw")}`,
  ];
  for (const file of manifest.files.filter((f) => f.role === "artifact")) lines.push(`  ${file.path} (${file.origin}${file.versions !== undefined && file.versions > 1 ? `, ${file.versions} versions` : ""})`);
  if (manifest.references.length > 0) {
    lines.push("published artifacts referenced but not in the source (fetch them and re-run with --include):");
    for (const reference of manifest.references) lines.push(`  ${reference}`);
  }
  if (manifest.warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of manifest.warnings) lines.push(`  ${warning}`);
  }
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT_OK;
}

function runList(args: readonly string[], io: Io): number {
  const { positionals } = parseArgs({ args: [...args], allowPositionals: true, strict: true, options: {} });
  const source = positionals[0];
  if (source === undefined || positionals.length > 1) {
    io.stderr(`list takes exactly one SOURCE\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  for (const s of summarize(loadExport(resolve(source)))) {
    io.stdout(`${s.uuid}  ${s.updatedAt.slice(0, 10)}  ${String(s.messages).padStart(4)} msgs  ${s.name}\n`);
  }
  return EXIT_OK;
}

/** Entry point. Returns the process exit code. */
export function main(argv: readonly string[], io: Io = processIo, now: Date = new Date()): number {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "pack":
        return runPack(rest, io, now);
      case "list":
        return runList(rest, io);
      case undefined:
      case "-h":
      case "--help":
      case "help":
        io.stdout(USAGE);
        return command === undefined ? EXIT_USAGE : EXIT_OK;
      default:
        io.stderr(`unknown command "${command}"\n\n${USAGE}`);
        return EXIT_USAGE;
    }
  } catch (error: unknown) {
    if (error instanceof SourceError || error instanceof SyntaxError) {
      io.stderr(`source error: ${error.message}\n`);
      return EXIT_SOURCE;
    }
    if (error instanceof TypeError && "code" in error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS")) {
      io.stderr(`${error.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw error;
  }
}
