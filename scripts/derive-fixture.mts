// Sanitizer-backed fixture derivation harness (dev tool, not committed output).
//
// Behavior invariant #8: every fixture derived from real data is produced
// ONLY through the sanitizer (`createSanitizer`/`sanitizeLine`) and is
// reproducible via this committed script — no raw real content is ever
// committed. Source paths are CLI args only; nothing is hardcoded.
//
// Usage:
//   npx tsx scripts/derive-fixture.mts <srcParent.jsonl> <destPath.jsonl> [--max-lines N] [--subagents]
//
// Reads the source transcript line-by-line, writes only non-null
// `sanitizeLine` output (one JSON line each), and prints the counts-only
// audit. With `--subagents` it discovers the parent's
// `<sess>/subagents/agent-*.jsonl` (via the importer's discoverSubagentFiles)
// and writes each sanitized child into the layout the importer expects:
//
//   <destPath.jsonl>                                              (parent)
//   <dirname(dest)>/<basename(dest) w/o .jsonl>/subagents/<child> (children)
//
// One shared sanitizer instance is reused across the parent and every
// subagent so pseudonyms stay coherent across the whole derived bundle.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createSanitizer, type Sanitizer } from '../src/export/transcript-sanitizer.js';
import { discoverSubagentFiles } from '../src/ingestion/transcript-importer.js';

const USAGE =
  'usage: npx tsx scripts/derive-fixture.mts <srcParent.jsonl> <destPath.jsonl> [--max-lines N] [--subagents]';

interface Args {
  srcParent: string;
  destPath: string;
  maxLines: number | null;
  subagents: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let maxLines: number | null = null;
  let subagents = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--subagents') {
      subagents = true;
    } else if (arg === '--max-lines') {
      const value = argv[++i];
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        console.error(`--max-lines expects a positive integer, got: ${String(value)}`);
        console.error(USAGE);
        process.exit(1);
      }
      maxLines = n;
    } else {
      positional.push(arg);
    }
  }

  const [srcParent, destPath] = positional;
  if (!srcParent || !destPath) {
    console.error(USAGE);
    process.exit(1);
  }

  return { srcParent, destPath, maxLines, subagents };
}

/**
 * Sanitize one file: read it line-by-line, cap reading at `maxLines` SOURCE
 * lines (counting every line, including ones that sanitize to null), write
 * the non-null sanitized lines joined by `\n` with a trailing newline.
 * Returns the number of lines written. Creates parent dirs as needed.
 */
function deriveFile(
  sanitizer: Sanitizer,
  srcPath: string,
  destPath: string,
  maxLines: number | null,
): number {
  // Split on \n; tolerate a missing trailing newline and skip empty lines.
  const rawLines = readFileSync(srcPath, 'utf8').split('\n');

  const out: string[] = [];
  let sourceLinesRead = 0;
  for (const line of rawLines) {
    if (maxLines !== null && sourceLinesRead >= maxLines) break;
    if (line.length === 0) continue; // empty line: not a source record
    sourceLinesRead++;
    const sanitized = sanitizer.sanitizeLine(line);
    if (sanitized !== null) out.push(sanitized);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, out.length > 0 ? `${out.join('\n')}\n` : '', 'utf8');
  return out.length;
}

function main(): void {
  const { srcParent, destPath, maxLines, subagents } = parseArgs(process.argv.slice(2));

  // ONE sanitizer across parent + all subagents → coherent pseudonyms.
  const sanitizer = createSanitizer();

  const parentWritten = deriveFile(sanitizer, srcParent, destPath, maxLines);
  console.log(`parent: wrote ${parentWritten} line(s) → ${destPath}`);

  if (subagents) {
    // <dirname(dest)>/<basename(dest) without .jsonl>/subagents/<child filename>
    const destStem = basename(destPath, '.jsonl');
    const subDestDir = join(dirname(destPath), destStem, 'subagents');

    const childFiles = discoverSubagentFiles(srcParent);
    if (childFiles.length === 0) {
      console.log('subagents: none discovered for source parent');
    }
    for (const childSrc of childFiles) {
      const childDest = join(subDestDir, basename(childSrc));
      const childWritten = deriveFile(sanitizer, childSrc, childDest, maxLines);
      console.log(`subagent: wrote ${childWritten} line(s) → ${childDest}`);
    }
  }

  // Counts-only audit (never holds source strings or the seed).
  console.log(`audit: ${JSON.stringify(sanitizer.audit)}`);
}

main();
