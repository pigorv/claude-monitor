#!/usr/bin/env node

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const { VERSION } = await import('../shared/constants.js');

  const HELP = `claude-monitor v${VERSION}

Usage: claude-monitor <command> [options]

Commands:
  import [path]   One-time import of a single file or directory
  export <id>     Export a single session as a sanitized, re-importable zip
  start           Start dashboard server + auto-import new sessions every 5s
  status          Show DB stats and server status
  help            Show this help message

Options:
  --help, -h      Show this help message
  --version, -v   Show version number

Run 'claude-monitor <command> --help' for command-specific help.`;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case 'import': {
      const { importCommand } = await import('./commands/import.js');
      await importCommand(args.slice(1));
      break;
    }
    case 'export': {
      const { exportCommand } = await import('./commands/export.js');
      await exportCommand(args.slice(1));
      break;
    }
    case 'start': {
      const { startCommand } = await import('./commands/start.js');
      await startCommand(args.slice(1));
      break;
    }
    case 'status': {
      const { statusCommand } = await import('./commands/status.js');
      await statusCommand(args.slice(1));
      break;
    }
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
