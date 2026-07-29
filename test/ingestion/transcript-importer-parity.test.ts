import { describe, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { join } from 'node:path';
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

// T3.1 — Parity, FTS-parity, and property/differential tests for the incremental
// transcript-import feature.
//
// These prove Behavior #2 (an incremental update yields events + agent
// relationships + session aggregates IDENTICAL to a forced full re-import of the
// same final file, WITH and WITHOUT sub-agents), the FTS search-parity invariant
// (hits after an incremental update match a cold import), and Behavior #6 (a
// `{ force: true }` re-import WITHOUT `incremental` still deletes+reinserts, so
// row ids change).
//
// The harness mirrors transcript-importer-incremental.test.ts: enable the
// kill-switch via env, `vi.resetModules()` so CONFIG re-reads it, and open a
// file-backed DB per fresh load. The incremental session and the cold session
// derive the SAME session id from identical content, so they can never coexist
// in one DB — each is built in its own fresh DB (separate temp file), read out
// into plain arrays, and only then compared.

const TEST_ROOT = join(tmpdir(), `cm-parity-${Date.now()}`);
const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const ORIG_FLAG = process.env.CLAUDE_MONITOR_INCREMENTAL_IMPORT;
let dbCounter = 0;

type FreshModules = {
  connection: typeof import('../../src/db/connection.js');
  importer: typeof import('../../src/ingestion/transcript-importer.js');
  logger: typeof import('../../src/shared/logger.js');
};

/** Load the importer + DB modules fresh (with the flag on) and open a new DB. */
async function fresh(): Promise<FreshModules & { dbPath: string }> {
  vi.resetModules();
  const connection = await import('../../src/db/connection.js');
  const importer = await import('../../src/ingestion/transcript-importer.js');
  const logger = await import('../../src/shared/logger.js');
  logger.setLogLevel('debug'); // so the 'Import timing' debug line is emitted
  const dbPath = join(TEST_ROOT, `db-${dbCounter++}.sqlite`);
  connection.getDb(dbPath);
  return { connection, importer, logger, dbPath };
}

/** Capture stderr lines while running `fn`, then restore. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return logs;
}

function importMode(logs: string[]): string | undefined {
  const line = logs.find((l) => l.includes('Import timing'));
  if (!line) return undefined;
  const m = line.match(/"mode":"([\w-]+)"/);
  return m?.[1];
}

// ── Result readers (everything meaningful, minus volatile columns) ──────

type Row = Record<string, unknown>;

/**
 * All `events` columns for a session ordered by sequence_num, EXCEPT the
 * autoincrement `id`. sequence_num, agent_id, event_type, event_source,
 * tool_name, timestamp, the token columns, context_pct, input/output/thinking
 * text, duration_ms and metadata are all deterministic from the parse, so a
 * correct incremental update reproduces them byte-for-byte.
 */
function readEvents(connection: FreshModules['connection'], sessionId: string): Row[] {
  const rows = connection
    .getDb()
    .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY sequence_num ASC')
    .all(sessionId) as Row[];
  return rows.map(({ id: _id, ...rest }) => rest);
}

/** The raw autoincrement ids keyed by sequence_num — used only to prove a
 *  forced rebuild reinserts (Behavior #6). */
function readEventIdsBySeq(connection: FreshModules['connection'], sessionId: string): Map<number, number> {
  const rows = connection
    .getDb()
    .prepare('SELECT id, sequence_num FROM events WHERE session_id = ? ORDER BY sequence_num ASC')
    .all(sessionId) as { id: number; sequence_num: number }[];
  return new Map(rows.map((r) => [r.sequence_num, r.id]));
}

/**
 * All `agent_relationships` columns for a session ordered by child_agent_id,
 * EXCEPT the autoincrement `id` and the two columns that legitimately reflect
 * where the file was read from / when: child_transcript_path (an absolute path
 * that differs between the two temp layouts) and child_imported_mtime (a
 * file-read timestamp). Everything else is recomputed from identical bytes and
 * must match.
 */
function readAgentRels(connection: FreshModules['connection'], sessionId: string): Row[] {
  const rows = connection
    .getDb()
    .prepare('SELECT * FROM agent_relationships WHERE parent_session_id = ? ORDER BY child_agent_id ASC')
    .all(sessionId) as Row[];
  return rows.map(({ id: _id, child_transcript_path: _p, child_imported_mtime: _m, ...rest }) => rest);
}

/** Session aggregate columns that must match a cold import — token totals,
 *  counts, cost, peak_context_pct, duration. Excludes the last_imported_*
 *  checkpoint columns and volatile per-file columns (transcript_path). */
function readSessionAggregates(connection: FreshModules['connection'], sessionId: string): Row {
  return connection
    .getDb()
    .prepare(
      `SELECT total_input_tokens, total_output_tokens, total_cache_read_tokens,
              total_cache_write_tokens, total_input_tokens_billed,
              total_cache_write_5m_tokens, total_cache_write_1h_tokens,
              peak_context_pct, compaction_count, tool_call_count, subagent_count,
              duration_ms, cost_estimate_usd
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as Row;
}

/** All event rows (by sequence_num) that the FTS index matches for a session,
 *  via the same events_fts join the production search uses. Ordered so the two
 *  imports can be compared position-for-position. */
function ftsHitSeqs(connection: FreshModules['connection'], sessionId: string, matchExpr: string): number[] {
  const rows = connection
    .getDb()
    .prepare(
      `SELECT e.sequence_num AS s
       FROM events_fts f JOIN events e ON e.id = f.rowid
       WHERE events_fts MATCH ? AND e.session_id = ?
       ORDER BY e.sequence_num ASC`,
    )
    .all(matchExpr, sessionId) as { s: number }[];
  return rows.map((r) => r.s);
}

// ── Snapshot bundle + comparison ────────────────────────────────────

interface Snapshot {
  events: Row[];
  rels: Row[];
  session: Row;
  mode?: string;
}

function readSnapshot(connection: FreshModules['connection'], sessionId: string, mode?: string): Snapshot {
  return {
    events: readEvents(connection, sessionId),
    rels: readAgentRels(connection, sessionId),
    session: readSessionAggregates(connection, sessionId),
    mode,
  };
}

function assertParity(incremental: Snapshot, cold: Snapshot, label: string): void {
  assert.deepEqual(incremental.events, cold.events, `${label}: events (incl. sequence_num) must equal a cold import`);
  assert.deepEqual(incremental.rels, cold.rels, `${label}: agent_relationships must equal a cold import`);
  assert.deepEqual(incremental.session, cold.session, `${label}: session aggregates must equal a cold import`);
}

// ── Layout helpers ──────────────────────────────────────────────────

let runCounter = 0;
function newRunDir(tag: string): string {
  const dir = join(TEST_ROOT, `${tag}-${runCounter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fixtureLines(relPath: string): string[] {
  return readFileSync(join(FIXTURES, relPath), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

const SUBAGENT_SID = '9f5e3bfd-73b8-4421-9e78-e736180128b4';
const SUBAGENT_CHILD = 'agent-a2971fff8de444861.jsonl';

/**
 * Lay out the real sub-agent fixture inside `runDir` as
 *   {runDir}/{sid}.jsonl                              (parent — caller writes body)
 *   {runDir}/{sid}/subagents/{child}.jsonl            (copied verbatim)
 * so discoverSubagentFiles finds the child. Returns the parent path.
 */
function layoutSubagentParent(runDir: string): string {
  const parentPath = join(runDir, `${SUBAGENT_SID}.jsonl`);
  const subDir = join(runDir, SUBAGENT_SID, 'subagents');
  mkdirSync(subDir, { recursive: true });
  copyFileSync(
    join(FIXTURES, 'subagent', SUBAGENT_SID, 'subagents', SUBAGENT_CHILD),
    join(subDir, SUBAGENT_CHILD),
  );
  return parentPath;
}

/**
 * Build the "incremental" snapshot: fresh full import of `lines[0,split)`, append
 * the remainder to the SAME file, then re-import `{ force:true, incremental:true }`.
 * `prepare(runDir)` returns the parent path (and lays out any sub-agent tree).
 */
async function buildIncremental(
  sessionId: string,
  lines: string[],
  split: number,
  tag: string,
  prepare: (runDir: string) => string,
): Promise<Snapshot> {
  const m = await fresh();
  const runDir = newRunDir(`${tag}-inc`);
  const parentPath = prepare(runDir);

  writeFileSync(parentPath, lines.slice(0, split).join('\n'));
  await m.importer.importTranscript(parentPath);
  appendFileSync(parentPath, '\n' + lines.slice(split).join('\n'));

  const logs = await captureLogs(async () => {
    await m.importer.importTranscript(parentPath, { force: true, incremental: true });
  });
  const snap = readSnapshot(m.connection, sessionId, importMode(logs));
  m.connection.closeDb();
  return snap;
}

/** Build the "cold" snapshot: a single fresh full import of the whole file. */
async function buildCold(
  sessionId: string,
  lines: string[],
  tag: string,
  prepare: (runDir: string) => string,
): Promise<Snapshot> {
  const m = await fresh();
  const runDir = newRunDir(`${tag}-cold`);
  const parentPath = prepare(runDir);
  writeFileSync(parentPath, lines.join('\n'));
  await m.importer.importTranscript(parentPath);
  const snap = readSnapshot(m.connection, sessionId);
  m.connection.closeDb();
  return snap;
}

// ── A synthetic plain (no sub-agent) transcript with a marker token in a
//    LATE message, so a split before it lands the token in the appended tail. ──

const SYN_SID = 'parity-syn-1';
const MARKER = 'zqxmarker'; // unique token that only appears in an appended message

function synUser(uuid: string, parent: string | null, text: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SYN_SID,
    version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: ts,
    uuid,
  });
}

function synAsstTool(uuid: string, parent: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SYN_SID,
    version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Reading the file first.' },
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: `tool-${uuid}`, name: 'Read', input: { file_path: '/tmp/project/x.ts' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    },
    timestamp: ts,
    uuid,
  });
}

function synToolResult(uuid: string, parent: string, toolUuid: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SYN_SID,
    version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${toolUuid}`, content: 'export const x = 1;' }] },
    timestamp: ts,
    uuid,
  });
}

function synAsstText(uuid: string, parent: string, text: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SYN_SID,
    version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    },
    timestamp: ts,
    uuid,
  });
}

// L0..L3 form a clean prefix; L4..L7 are the appended tail. The MARKER lives in
// L6 (an appended assistant message), so splitting at 4 puts it in the tail.
const SYN_LINES = [
  synUser('u1', null, 'Hello, read my file.', '2026-01-01T00:00:01.000Z'),
  synAsstTool('a1', 'u1', '2026-01-01T00:00:02.000Z'),
  synToolResult('u2', 'a1', 'a1', '2026-01-01T00:00:03.000Z'),
  synAsstText('a2', 'u2', 'The file has a single export.', '2026-01-01T00:00:04.000Z'),
  synUser('u3', 'a2', 'Now check the tests.', '2026-01-01T00:00:05.000Z'),
  synAsstTool('a3', 'u3', '2026-01-01T00:00:06.000Z'),
  synAsstText('a4', 'a3', `All good — the ${MARKER} suite passes.`, '2026-01-01T00:00:07.000Z'),
  synToolResult('u4', 'a3', 'a3', '2026-01-01T00:00:08.000Z'),
];
const SYN_SPLIT = 4;

const plainPrepare = (runDir: string): string => join(runDir, `${SYN_SID}.jsonl`);

// ── Tests ──────────────────────────────────────────────────────────

describe('incremental import — parity, FTS-parity, and property tests (T3.1)', () => {
  beforeEach(() => {
    process.env.CLAUDE_MONITOR_INCREMENTAL_IMPORT = '1';
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    if (ORIG_FLAG === undefined) delete process.env.CLAUDE_MONITOR_INCREMENTAL_IMPORT;
    else process.env.CLAUDE_MONITOR_INCREMENTAL_IMPORT = ORIG_FLAG;
  });

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  // ── Behavior #2 — parity WITHOUT sub-agents ──────────────────────
  it('Behavior #2: incremental (seed+append) equals a cold import — no sub-agents', async () => {
    const incremental = await buildIncremental(SYN_SID, SYN_LINES, SYN_SPLIT, 'syn', plainPrepare);
    assert.equal(incremental.mode, 'incremental', 'the append must take the incremental path');

    const cold = await buildCold(SYN_SID, SYN_LINES, 'syn', plainPrepare);
    assertParity(incremental, cold, 'no-subagents');
  });

  // ── Astral-character regression: emoji in the appended tail must NOT
  //    spuriously self-heal. The row signature counts Unicode code points on
  //    both sides; before that fix, SQLite length() (code points) vs JS
  //    String.length (UTF-16 units) disagreed on any emoji, so this same append
  //    logged mode 'incremental-healed' and did a full reinsert every tick. ──
  it('astral chars in the appended tail stay incremental and match a cold import', async () => {
    const emojiLines = [
      synUser('u1', null, 'Hello, read my file.', '2026-01-01T00:00:01.000Z'),
      synAsstTool('a1', 'u1', '2026-01-01T00:00:02.000Z'),
      synToolResult('u2', 'a1', 'a1', '2026-01-01T00:00:03.000Z'),
      synAsstText('a2', 'u2', 'The file has a single export.', '2026-01-01T00:00:04.000Z'),
      synUser('u3', 'a2', 'Thanks!', '2026-01-01T00:00:05.000Z'),
      // Astral characters (each 1 code point but 2 UTF-16 units) live ONLY in the
      // appended tail, so a spurious heal shows up as mode !== 'incremental'.
      synAsstText('a3', 'u3', 'Done 🤖 — shipped 🚀 with an astral 𝕏.', '2026-01-01T00:00:06.000Z'),
    ];
    const split = 4;

    const incremental = await buildIncremental(SYN_SID, emojiLines, split, 'emoji', plainPrepare);
    assert.equal(
      incremental.mode,
      'incremental',
      'an emoji in the appended tail must NOT force a self-heal',
    );

    const cold = await buildCold(SYN_SID, emojiLines, 'emoji', plainPrepare);
    assertParity(incremental, cold, 'astral-in-tail');
  });

  // ── Behavior #2 — parity WITH sub-agents (real fixture) ──────────
  it('Behavior #2: incremental equals a cold import — WITH sub-agents (real fixture)', async () => {
    const lines = fixtureLines(join('subagent', `${SUBAGENT_SID}.jsonl`));
    // Split at two points, both AFTER the Agent tool_use (line 3): a mid-transcript
    // split and a late one. The sub-agent child is UNCHANGED across the append —
    // its rows must end exactly where a cold re-import puts them.
    for (const split of [20, 34]) {
      const incremental = await buildIncremental(SUBAGENT_SID, lines, split, `sub${split}`, layoutSubagentParent);
      assert.equal(incremental.mode, 'incremental', `split ${split}: append must take the incremental path`);
      // The fixture really does carry a sub-agent relationship + child events.
      assert.ok(incremental.rels.length > 0, `split ${split}: expected an agent_relationship row`);
      assert.ok(
        incremental.events.some((e) => e.agent_id != null),
        `split ${split}: expected sub-agent events`,
      );

      const cold = await buildCold(SUBAGENT_SID, lines, `sub${split}`, layoutSubagentParent);
      assertParity(incremental, cold, `with-subagents split=${split}`);
    }
  });

  // ── FTS search-parity ────────────────────────────────────────────
  it('FTS: a token in an appended message is found after an incremental update, same as a cold import', async () => {
    const matchExpr = `"${MARKER}"`; // literal FTS5 term, mirrors buildFtsMatch output

    // Incremental: prefix has no MARKER; the append re-tokenizes the new tail.
    const im = await fresh();
    const runDir = newRunDir('fts-inc');
    const parentPath = plainPrepare(runDir);
    writeFileSync(parentPath, SYN_LINES.slice(0, SYN_SPLIT).join('\n'));
    await im.importer.importTranscript(parentPath);
    // Before the append, the MARKER is not in any indexed row.
    assert.equal(ftsHitSeqs(im.connection, SYN_SID, matchExpr).length, 0, 'MARKER absent before the append');

    appendFileSync(parentPath, '\n' + SYN_LINES.slice(SYN_SPLIT).join('\n'));
    const logs = await captureLogs(async () => {
      await im.importer.importTranscript(parentPath, { force: true, incremental: true });
    });
    assert.equal(importMode(logs), 'incremental', 'the append must take the incremental path');
    const incHits = ftsHitSeqs(im.connection, SYN_SID, matchExpr);
    im.connection.closeDb();

    // Cold: one-shot import of the full file.
    const cm = await fresh();
    const coldPath = plainPrepare(newRunDir('fts-cold'));
    writeFileSync(coldPath, SYN_LINES.join('\n'));
    await cm.importer.importTranscript(coldPath);
    const coldHits = ftsHitSeqs(cm.connection, SYN_SID, matchExpr);
    cm.connection.closeDb();

    assert.ok(incHits.length > 0, 'the appended MARKER row is indexed and searchable');
    assert.deepEqual(incHits, coldHits, 'incremental FTS hits (by sequence_num) match a cold import');
    // The prefix index survived the append (it re-tokenized only the tail): the
    // hit sits at the appended assistant message, not in the prefix range.
    assert.ok(
      incHits.every((s) => s >= SYN_SPLIT - 1),
      'the hit is in the appended tail, proving the prefix index was left intact',
    );
  });

  // ── Property / differential test across many split points ─────────
  it('property: splitting a real fixture at any line index yields a cold-import-identical result', async () => {
    const lines = fixtureLines(join('happy', 'sample-session.jsonl'));
    const sid = 'sess-001'; // embedded sessionId of the fixture
    const n = lines.length;
    assert.ok(n >= 4, 'fixture should have enough lines to split');

    // The cold result is identical regardless of split — compute it once.
    const cold = await buildCold(sid, lines, 'prop-cold', plainPrepare);

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: n - 1 }), async (split) => {
        // Boundary-heavy split points (mid-tool-call, mid-stream, mid-turn) are the
        // point: fast-check explores them across the [1, n-1] range. A tiny prefix
        // that parses to zero messages legitimately routes to the full path on the
        // second call (session not yet present) — parity must still hold, so we
        // assert equality, not the mode.
        const incremental = await buildIncremental(sid, lines, split, `prop${split}`, plainPrepare);
        assertParity(incremental, cold, `split=${split}`);
      }),
      { numRuns: 25 },
    );
  });

  // ── Behavior #6 — a forced rebuild WITHOUT incremental still reinserts ──
  it('Behavior #6: { force: true } with no incremental deletes+reinserts (event ids change)', async () => {
    const m = await fresh();
    const parentPath = plainPrepare(newRunDir('b6'));
    writeFileSync(parentPath, SYN_LINES.join('\n'));

    await m.importer.importTranscript(parentPath);
    const before = readEventIdsBySeq(m.connection, SYN_SID);
    const beforeData = readEvents(m.connection, SYN_SID);
    assert.ok(before.size > 0);

    // Forced re-import of the unchanged file WITHOUT the incremental flag.
    const logs = await captureLogs(async () => {
      await m.importer.importTranscript(parentPath, { force: true });
    });
    assert.equal(importMode(logs), 'full', 'no incremental flag → the full delete+reinsert path');

    const after = readEventIdsBySeq(m.connection, SYN_SID);
    const afterData = readEvents(m.connection, SYN_SID);
    m.connection.closeDb();

    // Same logical rows...
    assert.deepEqual(afterData, beforeData, 'a forced rebuild reproduces the same event data');
    // ...but every id is new — a genuine delete+reinsert, not an in-place update.
    assert.equal(after.size, before.size, 'same number of events');
    for (const [seq, id] of after) {
      assert.notEqual(id, before.get(seq), `seq ${seq} should have a fresh autoincrement id after a forced rebuild`);
    }
  });
});
