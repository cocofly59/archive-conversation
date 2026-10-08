#!/usr/bin/env node
/**
 * Conversation archiver.
 *
 * Normalizes one conversation (a Claude Code or desktop session transcript, a session export,
 * a claude.ai data export, or pasted text) and the artifacts it produced into a single
 * .tar.gz archive that people and agents can read. Standard library
 * only; runs directly under Node 22.18 or later without a build step.
 */
import { main } from "./conversation-archive/cli.ts";

process.exitCode = main(process.argv.slice(2));
