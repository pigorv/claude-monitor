import { DEFAULT_CONFIG } from '../../shared/constants.js';
import { getDb } from '../../db/connection.js';
import { closeDb } from '../../db/connection.js';
import { collectJsonlFiles, runImport } from './import.js';
import * as logger from '../../shared/logger.js';

const USAGE = `Usage: claude-monitor watch [path] [--force]

  Import all transcripts from a directory (one-time scan).
  Defaults to ~/.claude/projects/ when no path is given.

Options:
  --force         Re-import even if session already exists
  --db <path>     Custom database path
  --verbose       Enable debug logging`;

/**
 * CLI handler for `claude-monitor watch [path]`
 */
export async function watchCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  let verbose = false;
  let force = false;
  let dbPath: string | undefined;
  const paths: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--db') {
      dbPath = args[++i];
    } else if (!arg.startsWith('--')) {
      paths.push(arg);
    }
  }

  if (verbose) {
    logger.setLogLevel('debug');
  }

  const targetPath = paths.length > 0 ? paths[0] : DEFAULT_CONFIG.claudeProjectsPath;

  // Initialize DB
  getDb(dbPath);

  try {
    const files = collectJsonlFiles(targetPath);
    if (files.length > 0) {
      const { errors } = await runImport(files, force);
      if (errors > 0) process.exit(1);
    }
  } finally {
    closeDb();
  }
}
