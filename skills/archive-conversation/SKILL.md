---
name: archive-conversation
description: "Capture one conversation (the current Cowork session, another Cowork or Claude Code session, or a claude.ai chat) with every artifact it produced into a single .tar.gz archive. Use when the user wants to export, hand over, or keep a conversation together with its files and artifacts."
---

# Archive a conversation

Produce one archive that holds the whole conversation and the last version of every artifact it produced. It records what was said and made; it decides nothing.

`$ARGUMENTS` may name the source (a file, a folder, a zip), the conversation, or the destination. Ask only for what you cannot find.

## 0. Locate the script and check Node

The script is `scripts/conversation-archive.ts` at the plugin root: `${CLAUDE_PLUGIN_ROOT}/scripts/conversation-archive.ts`, or, when that variable is empty, `../../scripts/conversation-archive.ts` from this skill's base directory. Call that path `ARCHIVER` below.

It needs Node 22.18 or later. Run `node --version`; if Node is missing or older, tell the user and stop.

## 1. Find the source

| Where the conversation happened | Source to give the script |
| --- | --- |
| This very session (Cowork or Claude Code) | The session-export tool when one is available, otherwise this session's transcript: the most recent `.jsonl` under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`. Confirm it is the right one with `grep -l "<a phrase from this conversation>"`. |
| Another Cowork or Claude Code session | The zip from the session menu's **Export**, or the session's folder or `.jsonl` transcript. Desktop app data lives in `~/Library/Application Support/Claude/` (macOS) or `~/.config/Claude/` (Linux), Claude Code transcripts in `~/.claude/projects/`. Search for a distinctive phrase: `grep -rl --include='*.jsonl' "<phrase>" <dir>`. |
| A claude.ai chat | The data export (claude.ai settings, Privacy, Export data): the zip, its folder, or its `conversations.json`. Run `list` and pick one with `--conversation`. |
| Anything else | Ask the user to paste the conversation, save it as a `.md` file, and use that. It is archived verbatim. |

Never read transcripts of unrelated sessions beyond what is needed to identify the right one.

## 2. Pack, then complete

```bash
node "$ARCHIVER" list <claude.ai export>
node "$ARCHIVER" pack <source> --out <file>.tar.gz [--conversation <uuid|name>] [--include <path>]... [--title "<title>"] [--force]
```

Run `pack` once and read its report, then re-run with `--force` and one `--include` (file or folder) per missing piece:

- **Published artifacts and docs** listed as "referenced but not in the source": fetch each one (the Artifact tool's `read` action, or the docs connector's read or export) and include it.
- **Files the session saved to its working or outputs folder** (documents, decks, spreadsheets, images): include that folder. Text files written or edited through the conversation are rebuilt automatically; binaries and command outputs are not.
- **Uploaded files reported missing**: ask the user for them.

An included file replaces a recovered artifact at the same path. Set `--title` when the derived title is an id or the first words of a prompt. Exit code 1 means the source is unreadable or ambiguous; the message says what to do.

**Destination.** In Cowork, write the archive to `/tmp` first, then copy it into the folder shared with the user (the outputs or working folder), so it reaches their computer. Elsewhere, use the user's choice or the current directory.

The archive holds one root folder:

```
<date>-<slug>/
  manifest.json       source, period, counts, every file with origin, versions and sha256, references, warnings
  conversation.md     the conversation in order: messages, tool calls and results (long ones clipped)
  conversation.json   the same, normalized and complete
  artifacts/          last version of every file or artifact produced, plus included files
  attachments/        text extracted from files the user uploaded
  raw/                the untouched source
```

## 3. Check and report

- **Secrets**: the script flags likely secrets per file. Tell the user which files and kinds before the archive is shared. Never edit the archive to redact.
- **Completeness**: compare the artifact list with what the conversation says it produced, and report anything still missing.
- The raw transcript contains every tool output of the session. Mention it if the archive will be shared more widely than the conversation was.

Report the archive path, its artifacts, what is missing and why, and the warnings. Then stop.
