---
name: archive-conversation
description: "Capture one conversation (the current Cowork task or chat, another Cowork or Claude Code session, or a claude.ai chat) with every artifact it produced into a single .tar.gz archive the user can download, including from a phone. Use when the user wants to export, hand over, or keep a conversation together with its files and artifacts."
---

# Archive a conversation

Produce one archive that holds the whole conversation and the last version of every artifact it produced, and hand it to the user as a downloadable file. It records what was said and made; it decides nothing.

`$ARGUMENTS` may name the source (a file, a folder, a zip), the conversation, or the destination. Ask only for what you cannot find.

## 0. Know where you run

The same skill runs in different places. Check, do not assume:

| Environment | Transcript on disk | Where the user gets the archive |
| --- | --- | --- |
| Cowork on a computer, or started from a phone and running on the user's computer | Usually yes | The folder shared with the user (outputs or working folder) |
| Cowork running remotely (web or phone, computer off) | Maybe | The task's output files, shown in the app on every device |
| Chat (web, desktop or mobile app) with code execution | No | The output folder the environment names for files given to the user (in claude.ai, usually `/mnt/user-data/outputs`) |
| Claude Code | Yes | The user's choice, or the current directory |

Call the destination folder `OUT`. Write the archive to `/tmp` first, then copy it into `OUT`. Without code execution at all, say that the archive cannot be built here and offer to write the conversation as a Markdown file instead.

## 1. Locate the script and check Node

The script is `${CLAUDE_PLUGIN_ROOT}/scripts/conversation-archive.ts`, or, when that variable is empty, `../../scripts/conversation-archive.ts` from this skill's base directory. Call it `ARCHIVER`. It needs Node 22.18 or later: run `node --version`. If Node is missing or older, use the manual fallback in step 4.

Tell the user which version of this plugin is running, first thing: `node "$ARCHIVER" version` prints it, and so does the first line of every `pack` report. Without Node, read `version` from `.claude-plugin/plugin.json` at the plugin root.

## 2. Find the source

| Conversation | Source |
| --- | --- |
| This one, with a transcript on disk | The session-export tool when one is available, otherwise the most recent `.jsonl` under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`. Confirm it with `grep -l "<a phrase from this conversation>"`. |
| This one, with no transcript on disk | Reconstruct it (below) into `/tmp/conversation.md` and pack it with `--reconstructed`. |
| Another Cowork or Claude Code session | The zip from the session menu's **Export**, or the session's folder or `.jsonl`. Desktop data lives in `~/Library/Application Support/Claude/` (macOS) or `~/.config/Claude/` (Linux), Claude Code transcripts in `~/.claude/projects/`. Search with `grep -rl --include='*.jsonl' "<phrase>" <dir>`. |
| A claude.ai chat, from elsewhere | The data export (claude.ai settings, Privacy, Export data): the zip, its folder, or `conversations.json`. Run `list`, then pick one with `--conversation`. |
| Anything else | Ask the user to paste it, save it as a `.md` file, and pack that. |

Never read transcripts of unrelated sessions beyond what is needed to identify the right one.

**Reconstructing.** Write every turn you can see, in order, as `## User` and `## Assistant` sections under a `# <title>` heading. Copy user messages verbatim. Copy your replies verbatim; for tool calls, give the tool, its main input, and the outcome in one line. Never invent or smooth over: where earlier turns were compacted or are not visible, write `[earlier turns not available]` at that point.

## 3. Pack, then complete

```bash
node "$ARCHIVER" list <claude.ai export>
node "$ARCHIVER" pack <source> --out /tmp/<name>.tar.gz [--conversation <uuid|name>] [--include <path>]... [--title "<title>"] [--reconstructed] [--force]
```

Read the report, then re-run with `--force` and one `--include` (file or folder) per missing piece:

- **Files the conversation produced** in `OUT`, the working folder, or anywhere you wrote them: include them. A transcript rebuilds text files it wrote or edited; it cannot rebuild binaries or command outputs, and a reconstruction rebuilds nothing.
- **Artifacts and docs** listed as "not in the archive", or shown in this chat: fetch or write each one to `/tmp` and include it as `--include <url>=<path>`, so the archive records which link it stands for. Links to pages the session published from a file it kept are resolved on their own.
- **Uploaded files reported missing**: ask the user for them.

An included file replaces a recovered one at the same path.

**Incomplete conversations.** When the report lists a compaction under "incomplete", the turns before it are gone from the transcript; only the summary written at compaction remains, and the archive marks it as such. The script already looks for them in the other transcripts of the same folder. If they are not there, tell the user how many prompts are missing and that only the summary covers them; never fill the gap yourself. Set `--title` when the derived title is an id or the first words of a prompt. Exit code 1 means the source is unreadable or ambiguous; the message says what to do. Copy the archive into `OUT`.

## 4. Manual fallback, without Node 22.18

Build the same layout by hand in `/tmp/<date>-<slug>/`: `conversation.md` (the source, or a reconstruction), `artifacts/`, `raw/` (the source files, untouched), and a `manifest.json` with `format` `"conversation-archive/1"`, `title`, `source` (`kind`, `name`), `packedAt`, `files` (path and `sha256` of each, from `sha256sum` or `shasum -a 256`), `packer` (`name` `"archive-conversation"`, `version` from `.claude-plugin/plugin.json`), and `warnings` (including `"packed manually"`). Then `tar -czf /tmp/<date>-<slug>.tar.gz -C /tmp <date>-<slug>` and copy it into `OUT`.

The archive holds one root folder:

```
<date>-<slug>/
  manifest.json       source, period, counts, every file with origin, versions and sha256, references, warnings
  conversation.md     the conversation in order
  conversation.json   the same, normalized and complete (transcripts and exports only)
  artifacts/          last version of every file or artifact produced, plus included files
  attachments/        text extracted from files the user uploaded
  raw/                the untouched source
```

## 5. Check and report

- **Secrets**: the script flags likely secrets per file. Tell the user which files and kinds before they share the archive. Never edit the archive to redact.
- **Completeness**: compare the artifacts with what the conversation says it produced, and report anything still missing.
- The raw transcript contains every tool output of the session. Mention it if the archive will be shared more widely than the conversation was.

Report the plugin version, where the archive is, what it holds, whether the conversation was read from a transcript or reconstructed, whether any earlier turns are missing, which links are not in the archive, and the warnings. On a phone, the user saves it from the file shown in the conversation. Then stop.
