# archive-conversation

A Claude plugin that captures one conversation, with every artifact it produced, into a single `.tar.gz` archive: the conversation as Markdown and JSON, the last version of each artifact, extracted attachments, the untouched source, and a manifest with checksums.

Sources: the current Cowork task or chat, a Cowork or Claude Code session export, a claude.ai data export, or pasted text. Works on a computer, on the web, and from the mobile apps. The script needs Node 22.18 or later and nothing else; without it, the skill packs the archive by hand.

## Install

- **Claude app (chat and Cowork, any device)**: in claude.ai or the desktop app, open **Customize > Plugins > Add > Add marketplace**, enter `cocofly59/archive-conversation`, then add the plugin. Or download `archive-conversation.plugin` from the [latest release](https://github.com/cocofly59/archive-conversation/releases/latest) and use **Add > Upload plugin**. The plugin is saved to your account, so it is then available on the mobile apps too.
- **Claude Code**: `/plugin marketplace add cocofly59/archive-conversation`, then `/plugin install archive-conversation@archive-conversation`.

## Use

Ask Claude to archive the conversation, or type `/archive-conversation`. The archive is delivered as a file in the conversation (or in your Cowork folder on a computer).

## License

MIT
