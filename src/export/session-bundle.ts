import { basename, dirname, join, relative } from 'node:path';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Buffer } from 'node:buffer';
import { getSession } from '../db/queries/sessions.js';
import { discoverSubagentFiles } from '../ingestion/transcript-importer.js';
import { createSanitizer, type AuditSummary, type Sanitizer } from './transcript-sanitizer.js';
import { zipBuffer, type ZipEntry } from './zip.js';

// ── Session bundle assembly ─────────────────────────────────────────
//
// buildSessionBundle resolves a session's transcript on disk and packs
// the parent plus every discovered subagent into a zip in Claude Code's
// on-disk layout so `claude-monitor import` re-ingests the receiver's
// copy unchanged. Two modes:
//
//   sanitize: true (default) — the parent and every subagent are run
//   through ONE shared sanitizer (so pseudonyms are coherent across the
//   whole bundle):
//
//     <sessionId>.jsonl
//     <sessionId>/subagents/<agent>.jsonl
//     sanitization-report.json   (counts-only audit; never the seed)
//
//   The seed is never serialized: the audit is counts-only and the seed
//   lives inside the Pseudonymizer, which never exposes it.
//
//   sanitize: false — the parent and every subagent are copied
//   byte-for-byte verbatim (no sanitizer, no audit), with a manifest
//   marking the bundle as raw:
//
//     <sessionId>.jsonl
//     <sessionId>/subagents/<agent>.jsonl
//     export-manifest.json       ({ "sanitized": false })

export interface SessionBundle {
  zip: Buffer;
  filename: string;
  audit?: AuditSummary;
}

/**
 * Thrown for the known, user-actionable export failures (unknown session,
 * null transcript path, missing transcript file). Callers can map these to a
 * 404 while letting any *unexpected* error surface as a real 500 instead of
 * masquerading as "not found".
 */
export class SessionExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExportError';
  }
}

/**
 * Read one transcript file line-by-line, sanitize each line through the
 * shared sanitizer, drop null results, and return the joined sanitized
 * JSONL (no trailing newline). Blank lines are skipped.
 */
async function sanitizeFile(sanitizer: Sanitizer, filePath: string): Promise<string> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const out: string[] = [];
  for await (const line of rl) {
    if (line.length === 0) continue;
    const sanitized = sanitizer.sanitizeLine(line);
    if (sanitized !== null) out.push(sanitized);
  }
  return out.join('\n');
}

/** Read one transcript file verbatim, returning its bytes unchanged. */
function readFileVerbatim(filePath: string): Buffer {
  return readFileSync(filePath);
}

/**
 * Build an importable zip bundle for a single session.
 *
 * @param sessionId  The session to export.
 * @param options.sanitize  When true (the default) the parent and every
 *                   subagent are pseudonymized through one shared sanitizer
 *                   and a counts-only `sanitization-report.json` is added.
 *                   When false the transcripts are copied byte-for-byte and
 *                   an `export-manifest.json` marks the bundle as raw; no
 *                   sanitizer runs, so the returned `audit` is undefined.
 * @param options.seed  TEST-ONLY injection seam. Production callers pass
 *                   nothing so each export uses a fresh random seed
 *                   (`crypto.randomBytes(16)` inside the Pseudonymizer).
 *                   A fixed seed is permitted only so tests can assert the
 *                   seed bytes never appear in any bundle entry.
 */
export async function buildSessionBundle(
  sessionId: string,
  options?: { sanitize?: boolean; seed?: Buffer },
): Promise<SessionBundle> {
  const { sanitize = true, seed } = options ?? {};
  const session = getSession(sessionId);
  if (!session) {
    throw new SessionExportError(
      `Cannot export session "${sessionId}": no such session. Run "claude-monitor import" first, or check the session id.`,
    );
  }

  const transcriptPath = session.transcript_path;
  if (!transcriptPath) {
    throw new SessionExportError(
      `Cannot export session "${sessionId}": its transcript path was never recorded. Re-import the session with "claude-monitor import --force".`,
    );
  }
  if (!existsSync(transcriptPath)) {
    throw new SessionExportError(
      `Cannot export session "${sessionId}": the transcript file no longer exists at ${transcriptPath}. Re-import the session before exporting.`,
    );
  }

  const base = basename(transcriptPath, '.jsonl'); // == sessionId by convention.
  // On-disk subagent files live under `{sessionDir}/subagents/...`. Naming a
  // zip entry by the file's path RELATIVE to this dir preserves nested depth
  // (e.g. `subagents/workflows/<runId>/agent-x.jsonl`) instead of flattening
  // it to a single level (which risks cross-run basename collisions).
  const sessionDir = join(dirname(transcriptPath), base);
  // ZIP entry names must use forward slashes regardless of host OS (APPNOTE
  // 4.4.17); on Windows `relative()` yields `\`, so normalize to POSIX `/`.
  const subEntryName = (subFile: string): string =>
    `${base}/${relative(sessionDir, subFile).split('\\').join('/')}`;
  const entries: ZipEntry[] = [];
  // Raw bundles carry a `-raw` marker in the filename so an unsanitized
  // artifact can't be mistaken for a safe, shareable one on disk (the
  // in-bundle manifest and the CLI warning are the other two safeguards).
  const filename = `claude-monitor-session-${sessionId}${sanitize ? '' : '-raw'}.zip`;

  // ZIP entry names must use forward slashes regardless of host OS
  // (APPNOTE 4.4.17) — `path.join` would emit `\` on Windows and break
  // subagent discovery when the bundle is re-imported on macOS/Linux.
  if (!sanitize) {
    // Raw mode: byte-for-byte verbatim copy of every transcript.
    entries.push({ name: `${base}.jsonl`, data: readFileVerbatim(transcriptPath) });

    // Reuse the importer's discovery helper — no duplicated /subagents/ logic.
    for (const subFile of discoverSubagentFiles(transcriptPath)) {
      const name = subEntryName(subFile);
      entries.push({ name, data: readFileVerbatim(subFile) });
    }

    entries.push({
      name: 'export-manifest.json',
      data: Buffer.from(JSON.stringify({ sanitized: false }, null, 2), 'utf8'),
    });

    return { zip: zipBuffer(entries), filename, audit: undefined };
  }

  // ONE sanitizer across parent + all subagents → coherent pseudonyms.
  const sanitizer = createSanitizer(seed);

  const parentJsonl = await sanitizeFile(sanitizer, transcriptPath);
  entries.push({ name: `${base}.jsonl`, data: Buffer.from(parentJsonl, 'utf8') });

  // Reuse the importer's discovery helper — no duplicated /subagents/ logic.
  for (const subFile of discoverSubagentFiles(transcriptPath)) {
    const subJsonl = await sanitizeFile(sanitizer, subFile);
    const name = subEntryName(subFile);
    entries.push({ name, data: Buffer.from(subJsonl, 'utf8') });
  }

  // Counts-only audit. JSON.stringify never touches the seed (it lives in
  // the Pseudonymizer and is never part of the audit object).
  entries.push({
    name: 'sanitization-report.json',
    data: Buffer.from(JSON.stringify(sanitizer.audit, null, 2), 'utf8'),
  });

  return {
    zip: zipBuffer(entries),
    filename,
    audit: sanitizer.audit,
  };
}
