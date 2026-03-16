#!/usr/bin/env node

import { VERSION } from '../shared/constants.js';
import { importCommand } from './commands/import.js';
import { watchCommand } from './commands/watch.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';

const HELP = `claude-monitor v${VERSION}

Usage: claude-monitor <command> [options]

Commands:
  import [path]   One-time import of a single file or directory
  watch [path]    Scan and import all transcripts (default: ~/.claude/projects/)
  start           Start dashboard server + auto-import new sessions every 5s
  status          Show DB stats and server status
  help            Show this help message

Options:
  --help, -h      Show this help message
  --version, -v   Show version number

Run 'claude-monitor <command> --help' for command-specific help.`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case 'import':
      await importCommand(args.slice(1));
      break;
    case 'watch':
      await watchCommand(args.slice(1));
      break;
    case 'start':
      await startCommand(args.slice(1));
      break;
    case 'status':
      await statusCommand(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(`Run 'claude-monitor --help' for available commands.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
