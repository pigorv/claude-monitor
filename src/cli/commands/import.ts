import { resolve } from 'node:path';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { getDb } from '../../db/connection.js';
import { closeDb } from '../../db/connection.js';
import { importTranscripts } from '../../ingestion/transcript-importer.js';
import { DEFAULT_CONFIG } from '../../shared/constants.js';

const USAGE = `Usage: claude-monitor import [path] [--force]

  One-time import of JSONL transcript file(s) or a directory.
  Defaults to ~/.claude/projects/ when no path is given.

Options:
  --force    Re-import even if session already exists`;

/**
 * Collect all .jsonl files from a path (file or directory).
 */
export function collectJsonlFiles(inputPath: string): string[] {
  const resolved = resolve(inputPath);

  if (!existsSync(resolved)) {
    console.error(`Error: Path does not exist: ${resolved}`);
    process.exit(1);
  }

  const stat = statSync(resolved);

  if (stat.isFile()) {
    if (!resolved.endsWith('.jsonl')) {
      console.error(`Error: File is not a .jsonl file: ${resolved}`);
      process.exit(1);
    }
    return [resolved];
  }

  if (stat.isDirectory()) {
    const files = collectJsonlFilesRecursive(resolved);

    if (files.length === 0) {
      console.log(`No .jsonl files found in: ${resolved}`);
      return [];
    }

    return files;
  }

  console.error(`Error: Path is neither a file nor a directory: ${resolved}`);
  process.exit(1);
}

function collectJsonlFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonlFilesRecursive(fullPath));
    } else if (entry.name.endsWith('.jsonl')) {
      files.push(fullPath);
    }
  }
  // Sort so that parent transcripts come before subagent transcripts.
  return files.sort((a, b) => {
    const aIsSub = a.includes('/subagents/');
    const bIsSub = b.includes('/subagents/');
    if (aIsSub !== bIsSub) return aIsSub ? 1 : -1;
    return a.localeCompare(b);
  });
}

/**
 * Run a one-time import and print results. Used by both `import` and `watch` commands.
 */
export async function runImport(files: string[], force: boolean): Promise<{ imported: number; skipped: number; errors: number }> {
  console.log(`Importing ${files.length} file${files.length === 1 ? '' : 's'}...`);

  const results = await importTranscripts(files, { force });

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const result of results) {
    if (result.error) {
      console.error(`  ✗ ${result.error}`);
      errors++;
    } else if (result.skipped) {
      if (result.sessionId) {
        console.log(`  ⊘ ${result.sessionId} (already imported)`);
      }
      skipped++;
    } else {
      console.log(`  ✓ ${result.sessionId} — ${result.eventCount} events`);
      imported++;
    }
  }

  console.log(`Done: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  return { imported, skipped, errors };
}

/**
 * CLI handler for `claude-monitor import [path] [--force]`
 */
export async function importCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const force = args.includes('--force');
  const paths = args.filter((a) => !a.startsWith('--'));

  // Default to ~/.claude/projects/ when no path given
  const targetPath = paths.length > 0 ? paths[0] : DEFAULT_CONFIG.claudeProjectsPath;
  const files = collectJsonlFiles(targetPath);

  if (files.length === 0) return;

  // Initialize DB
  getDb();

  try {
    const { errors } = await runImport(files, force);
    if (errors > 0) process.exit(1);
  } finally {
    closeDb();
  }
}
