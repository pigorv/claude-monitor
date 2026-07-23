import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { getSession, sessionExists } from '../db/queries/sessions.js';
import { CONFIG } from '../shared/constants.js';

// ── Session clone ───────────────────────────────────────────────────
//
// cloneSession resolves a session's transcript on disk and writes a copy
// of it under the Claude projects dir for a chosen target directory, minted
// with a fresh session id. Every line's `sessionId` is rewritten to the new
// id and its `cwd` (where present) is repointed at the target dir; every
// other field — `uuid`, `parentUuid`, `leafUuid` refs, message content,
// usage — is preserved verbatim so `claude-monitor import` re-ingests it as
// a genuine session rooted in the target directory.
//
// This is the write-instead-of-zip sibling of src/export/session-bundle.ts;
// it deliberately mirrors that module's transcript-resolution guards and its
// stream-line-by-line read.

/**
 * Thrown for the known, user-actionable clone failures (unknown session,
 * null transcript path, missing transcript file, invalid target dir).
 * Mirrors {@link SessionExportError} so the route can map these to a 4xx
 * while letting any *unexpected* error surface as a real 500 instead of
 * masquerading as a client mistake.
 */
export class CloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneError';
  }
}

export interface CloneResult {
  /** The freshly minted session id of the clone (a UUID, ≠ the source id). */
  id: string;
  /** The absolute target directory the clone was rooted in. */
  projectPath: string;
}

/**
 * Encode an absolute filesystem path into Claude Code's on-disk project-dir
 * name by replacing every non-alphanumeric character with `-`.
 * Grounded on-disk: `/home/user/claude-monitor` → `-home-user-claude-monitor`.
 */
export function encodeProjectDirName(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** Expand a leading `~` (bare or `~/...`) to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Clone a session's transcript into a chosen target directory under a fresh
 * session id.
 *
 * Resolves and guards the source transcript (mirroring buildSessionBundle),
 * validates the target directory before touching disk, mints a collision-free
 * UUID, and writes the rewritten parent transcript to
 * `<claudeProjectsPath>/<slug(targetDir)>/<newId>.jsonl`.
 *
 * @param sessionId  The source session to clone.
 * @param options.targetDir  Absolute path (a leading `~` is expanded) to an
 *                   existing directory the clone should be rooted in.
 * @throws {CloneError} for an unknown session, a null/missing transcript, or
 *                   an invalid target directory. Nothing is written on throw.
 */
export async function cloneSession(
  sessionId: string,
  options: { targetDir: string },
): Promise<CloneResult> {
  // ── Resolve + guard the source transcript (mirrors session-bundle) ──
  const session = getSession(sessionId);
  if (!session) {
    throw new CloneError(
      `Cannot clone session "${sessionId}": no such session. Run "claude-monitor import" first, or check the session id.`,
    );
  }

  const transcriptPath = session.transcript_path;
  if (!transcriptPath) {
    throw new CloneError(
      `Cannot clone session "${sessionId}": its transcript path was never recorded. Re-import the session with "claude-monitor import --force".`,
    );
  }
  if (!existsSync(transcriptPath)) {
    throw new CloneError(
      `Cannot clone session "${sessionId}": the transcript file no longer exists at ${transcriptPath}. Cloning requires the raw transcript.`,
    );
  }

  // ── Validate the target dir BEFORE any write ────────────────────────
  const rawTarget = options.targetDir;
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') {
    throw new CloneError('Cannot clone: targetDir is required and must be a non-empty path.');
  }
  const targetDir = expandHome(rawTarget);
  if (!isAbsolute(targetDir)) {
    throw new CloneError(
      `Cannot clone: targetDir "${rawTarget}" must be an absolute path (e.g. /home/you/project).`,
    );
  }
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    throw new CloneError(
      `Cannot clone: targetDir "${targetDir}" is not an existing directory. Create it first, or pick an existing one.`,
    );
  }

  // ── Mint a fresh, collision-free session id ─────────────────────────
  const projectDir = join(CONFIG.claudeProjectsPath, encodeProjectDirName(targetDir));
  let newId = randomUUID();
  while (newId === sessionId || sessionExists(newId) || existsSync(join(projectDir, `${newId}.jsonl`))) {
    newId = randomUUID();
  }

  // ── Rewrite the parent transcript line-by-line ──────────────────────
  const rl = createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const out: string[] = [];
  for await (const line of rl) {
    if (line.length === 0) continue;
    out.push(rewriteLine(line, newId, targetDir));
  }

  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${newId}.jsonl`), out.join('\n'));

  // NOTE (T1.2): subagent copying and the synchronous re-import are layered on
  // top of this. The return shape is already the final one so T1.2 only adds
  // those steps; do not add the import call here.
  return { id: newId, projectPath: targetDir };
}

/**
 * Rewrite one JSONL line: set `sessionId` to the new id and, when a `cwd`
 * field is present, repoint it at the target dir. Every other field —
 * `uuid`, `parentUuid`, `leafUuid`, content, usage — is preserved verbatim.
 * A line that isn't a JSON object (malformed, or a bare scalar/array) is kept
 * byte-for-byte so no transcript data is lost.
 */
function rewriteLine(line: string, newId: string, targetDir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return line;
  }
  const obj = parsed as Record<string, unknown>;
  obj.sessionId = newId;
  if ('cwd' in obj) obj.cwd = targetDir;
  return JSON.stringify(obj);
}
