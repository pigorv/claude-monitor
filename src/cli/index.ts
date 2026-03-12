#!/usr/bin/env node

import { VERSION } from '../shared/constants.js';
import { importCommand } from './commands/import.js';
import { setupCommand } from './commands/setup.js';
import { startCommand } from './commands/start.js';
import { statusCommand } from './commands/status.js';

const HELP = `claude-monitor v${VERSION}

Usage: claude-monitor <command> [options]

Commands:
  start           Start the dashboard server
  status          Show hook configuration, DB stats, and server status
  import <path>   Import JSONL transcript file(s) or a directory
  setup           Configure Claude Code hooks for event capture
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
    case 'start':
      await startCommand(args.slice(1));
      break;
    case 'status':
      await statusCommand(args.slice(1));
      break;
    case 'import':
      await importCommand(args.slice(1));
      break;
    case 'setup':
      await setupCommand(args.slice(1));
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
