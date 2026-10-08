# archive-conversation

A Claude plugin that captures one conversation, with every artifact it produced, into a single `.tar.gz` archive: the conversation as Markdown and JSON, the last version of each artifact, extracted attachments, the untouched source, and a manifest with checksums.

Sources: the current Cowork or Claude Code session, a session export, a claude.ai data export, or pasted text. Requires Node 22.18 or later; no other dependency.

## Install

- **Cowork**: download `archive-conversation.plugin` from the [latest release](https://github.com/cocofly59/archive-conversation/releases/latest), drop it into a Cowork conversation, and accept it.
- **Claude Code**: `/plugin marketplace add cocofly59/archive-conversation`, then `/plugin install archive-conversation@archive-conversation`.

## Use

Ask Claude to archive the conversation, or run `/archive-conversation:archive-conversation`.

## License

MIT
