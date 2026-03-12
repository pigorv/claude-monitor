import { resolve } from 'node:path';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { getDb } from '../../db/connection.js';
import { closeDb } from '../../db/connection.js';
import { importTranscript, importTranscripts } from '../../ingestion/transcript-importer.js';
import * as logger from '../../shared/logger.js';

/**
 * Collect all .jsonl files from a path (file or directory).
 */
function collectJsonlFiles(inputPath: string): string[] {
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
      console.error(`Error: No .jsonl files found in directory: ${resolved}`);
      process.exit(1);
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
  // Subagent files live under .../subagents/ and share the parent's sessionId,
  // so importing them first would claim the session slot with incomplete data.
  return files.sort((a, b) => {
    const aIsSub = a.includes('/subagents/');
    const bIsSub = b.includes('/subagents/');
    if (aIsSub !== bIsSub) return aIsSub ? 1 : -1;
    return a.localeCompare(b);
  });
}

/**
 * CLI handler for `claude-monitor import <path> [--force]`
 */
export async function importCommand(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const paths = args.filter((a) => !a.startsWith('--'));

  if (paths.length === 0) {
    console.error('Usage: claude-monitor import <path> [--force]');
    console.error('');
    console.error('  Import a JSONL transcript file or all .jsonl files in a directory.');
    console.error('');
    console.error('Options:');
    console.error('  --force    Re-import even if session already exists');
    process.exit(1);
  }

  // Collect all files from all provided paths
  const files: string[] = [];
  for (const p of paths) {
    files.push(...collectJsonlFiles(p));
  }

  // Initialize DB
  getDb();

  try {
    console.log(`Importing ${files.length} file${files.length === 1 ? '' : 's'}...`);

    const results = await importTranscripts(files, { force });

    // Print results
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const result of results) {
      if (result.error) {
        console.error(`  ✗ ${result.error}`);
        errors++;
      } else if (result.skipped) {
        console.log(`  ⊘ ${result.sessionId} (already imported)`);
        skipped++;
      } else {
        console.log(`  ✓ ${result.sessionId} — ${result.eventCount} events`);
        imported++;
      }
    }

    console.log('');
    console.log(`Done: ${imported} imported, ${skipped} skipped, ${errors} errors`);

    if (errors > 0) {
      process.exit(1);
    }
  } finally {
    closeDb();
  }
}
