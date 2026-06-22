import { basename, join } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Buffer } from 'node:buffer';
import { getSession } from '../db/queries/sessions.js';
import { discoverSubagentFiles } from '../ingestion/transcript-importer.js';
import { createSanitizer, type AuditSummary, type Sanitizer } from './transcript-sanitizer.js';
import { zipBuffer, type ZipEntry } from './zip.js';

// ── Session bundle assembly ─────────────────────────────────────────
//
// buildSessionBundle resolves a session's transcript on disk, sanitizes
// the parent and every discovered subagent through ONE shared sanitizer
// (so pseudonyms are coherent across the whole bundle), and packs them
// into a zip in Claude Code's on-disk layout so `claude-monitor import`
// re-ingests the receiver's copy unchanged:
//
//   <sessionId>.jsonl
//   <sessionId>/subagents/<agent>.jsonl
//   sanitization-report.json   (counts-only audit; never the seed)
//
// The seed is never serialized: the audit is counts-only and the seed
// lives inside the Pseudonymizer, which never exposes it.

export interface SessionBundle {
  zip: Buffer;
  filename: string;
  audit: AuditSummary;
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

/**
 * Build a sanitized, importable zip bundle for a single session.
 *
 * @param sessionId  The session to export.
 * @param seed       TEST-ONLY injection seam. Production callers pass
 *                   nothing so each export uses a fresh random seed
 *                   (`crypto.randomBytes(16)` inside the Pseudonymizer).
 *                   A fixed seed is permitted only so tests can assert the
 *                   seed bytes never appear in any bundle entry.
 */
export async function buildSessionBundle(sessionId: string, seed?: Buffer): Promise<SessionBundle> {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(
      `Cannot export session "${sessionId}": no such session. Run "claude-monitor import" first, or check the session id.`,
    );
  }

  const transcriptPath = session.transcript_path;
  if (!transcriptPath) {
    throw new Error(
      `Cannot export session "${sessionId}": its transcript path was never recorded. Re-import the session with "claude-monitor import --force".`,
    );
  }
  if (!existsSync(transcriptPath)) {
    throw new Error(
      `Cannot export session "${sessionId}": the transcript file no longer exists at ${transcriptPath}. Re-import the session before exporting.`,
    );
  }

  // ONE sanitizer across parent + all subagents → coherent pseudonyms.
  const sanitizer = createSanitizer(seed);

  const base = basename(transcriptPath, '.jsonl'); // == sessionId by convention.
  const entries: ZipEntry[] = [];

  const parentJsonl = await sanitizeFile(sanitizer, transcriptPath);
  entries.push({ name: `${base}.jsonl`, data: Buffer.from(parentJsonl, 'utf8') });

  // Reuse the importer's discovery helper — no duplicated /subagents/ logic.
  for (const subFile of discoverSubagentFiles(transcriptPath)) {
    const subJsonl = await sanitizeFile(sanitizer, subFile);
    const name = join(base, 'subagents', basename(subFile));
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
    filename: `claude-monitor-session-${sessionId}.zip`,
    audit: sanitizer.audit,
  };
}
