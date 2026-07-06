import { resolve, join } from 'node:path';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { getDb, closeDb } from '../../db/connection.js';
import { buildSessionBundle } from '../../export/session-bundle.js';

const USAGE = `Usage: claude-monitor export <session-id> [--out <path>]

  Export a single session as a re-importable zip bundle. By default the bundle
  is sanitized and shareable — all file paths and content are pseudonymized or
  scrambled while the structure (timeline, token curve, compaction, agent tree)
  is preserved. Use --raw for a verbatim, UNSANITIZED bundle (do not share it).

Options:
  --out <path>   Write the zip to <path>. If <path> is an existing directory,
                 the bundle filename is appended. Defaults to ./<filename> in
                 the current directory.
  --raw          Export the real, UNSANITIZED transcript (real filesystem
  --no-sanitize  paths and message content). Opt-in; the sanitized bundle is
                 the default. Do not share a raw bundle.`;

/**
 * Resolve the output file path for the bundle.
 *
 * - No `--out`: write `./<filename>` in the cwd.
 * - `--out <dir>` where <dir> is an existing directory: write `<dir>/<filename>`.
 * - `--out <path>` otherwise: treat <path> as the full destination file path.
 */
function resolveOutPath(out: string | undefined, filename: string): string {
  if (!out) return resolve(filename);
  const resolved = resolve(out);
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return join(resolved, filename);
  }
  return resolved;
}

/**
 * CLI handler for `claude-monitor export <session-id> [--out <path>]`.
 */
export async function exportCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  // Parse `--out <path>`, `--raw` / `--no-sanitize`, and the positional session id.
  let out: string | undefined;
  let raw = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') {
      out = args[i + 1];
      i++;
    } else if (args[i] === '--raw' || args[i] === '--no-sanitize') {
      raw = true;
    } else if (!args[i].startsWith('--')) {
      positional.push(args[i]);
    }
  }

  const sessionId = positional[0];
  if (!sessionId) {
    console.error('Error: missing <session-id>.');
    console.error(USAGE);
    process.exit(1);
  }

  // Initialize DB.
  getDb();

  try {
    const bundle = await buildSessionBundle(sessionId, { sanitize: !raw });
    const outPath = resolveOutPath(out, bundle.filename);
    writeFileSync(outPath, bundle.zip);

    const { audit } = bundle;
    console.log(`Exported session ${sessionId} → ${outPath}`);
    if (audit) {
      console.log('Sanitization summary:');
      console.log(`  Lines emitted:        ${audit.emitted}`);
      console.log(`  Lines dropped:        ${audit.dropped}`);
      console.log(`  Snapshots dropped:    ${audit.droppedSnapshots}`);
      console.log(`  Fields dropped:       ${audit.droppedFields}`);
      console.log(`  Paths pseudonymized:  ${audit.pathsPseudonymized}`);
      console.log(`  Text values scrambled:${audit.scrambled}`);
      console.log(`  Malformed lines:      ${audit.malformed}`);
    } else {
      console.warn(
        'WARNING: This bundle is UNSANITIZED — it contains real filesystem paths and message content. Do not share it.',
      );
    }
  } catch (err) {
    // buildSessionBundle throws actionable errors for missing session /
    // null transcript path / gone file. Print the message, not a stack trace.
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    closeDb();
  }
}
