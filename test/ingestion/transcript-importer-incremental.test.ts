import { describe, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The incremental tail-append write path is behind CONFIG.incrementalImport,
// which is read once at module load. Enable it via env, then reset the module
// registry and import the importer + DB modules fresh so CONFIG picks it up.
// A file-backed DB survives the module reset (the singleton lives in each fresh
// connection module instance and is opened per-load below).

const TEST_ROOT = join(tmpdir(), `cm-incremental-${Date.now()}`);
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

interface RawEventRow {
  id: number;
  sequence_num: number;
  event_type: string;
  agent_id: string | null;
  tool_name: string | null;
  timestamp: string;
  input_data: string | null;
  output_data: string | null;
  thinking_text: string | null;
  duration_ms: number | null;
}

function readEvents(connection: FreshModules['connection'], sessionId: string): RawEventRow[] {
  return connection
    .getDb()
    .prepare(
      `SELECT id, sequence_num, event_type, agent_id, tool_name, timestamp,
              input_data, output_data, thinking_text, duration_ms
       FROM events WHERE session_id = ? ORDER BY sequence_num ASC`,
    )
    .all(sessionId) as RawEventRow[];
}

/** Everything about an event that identifies it except its DB rowid. */
function withoutId(rows: RawEventRow[]): Omit<RawEventRow, 'id'>[] {
  return rows.map(({ id: _id, ...rest }) => rest);
}

/** Session aggregate columns that must match a cold import (excludes volatile
 *  per-file columns like transcript_path). */
function readSessionAggregates(connection: FreshModules['connection'], sessionId: string): unknown {
  return connection
    .getDb()
    .prepare(
      `SELECT total_input_tokens, total_output_tokens, total_cache_read_tokens,
              total_cache_write_tokens, total_input_tokens_billed, peak_context_pct,
              compaction_count, tool_call_count, subagent_count, duration_ms, cost_estimate_usd
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
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

// ── Sample transcript lines ────────────────────────────────────────

const SID = 'inc-session-1';

function userMsg(uuid: string, parent: string | null, text: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SID,
    version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: text },
    timestamp: ts,
    uuid,
  });
}

function asstToolUse(uuid: string, parent: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SID,
    version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should read the file.' },
        { type: 'text', text: "I'll read it now." },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/project/x.ts' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    },
    timestamp: ts,
    uuid,
  });
}

function toolResult(uuid: string, parent: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SID,
    version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: "export const x = 1;" }] },
    timestamp: ts,
    uuid,
  });
}

function asstText(uuid: string, parent: string, text: string, ts: string): string {
  return JSON.stringify({
    parentUuid: parent,
    cwd: '/tmp/project',
    sessionId: SID,
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

// A complete, cleanly-ending transcript prefix (L1..L4).
const PREFIX_LINES = [
  userMsg('u1', null, 'Hello, read my file.', '2026-01-01T00:00:01.000Z'),
  asstToolUse('a1', 'u1', '2026-01-01T00:00:02.000Z'),
  toolResult('u2', 'a1', '2026-01-01T00:00:03.000Z'),
  asstText('a2', 'u2', 'The file has a single export.', '2026-01-01T00:00:04.000Z'),
];

// ── Tests ──────────────────────────────────────────────────────────

describe('importTranscript — incremental tail-append (flag on)', () => {
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

  it('Behavior #1: appending leaves prefix event ids untouched and inserts only tail rows', async () => {
    const { connection, importer, dbPath } = await fresh();
    const filePath = join(TEST_ROOT, 'b1.jsonl');
    writeFileSync(filePath, PREFIX_LINES.join('\n'));

    // Cold full import (session does not exist yet → full path, writes checkpoint).
    const first = await importer.importTranscript(filePath);
    assert.equal(first.skipped, false);

    const before = readEvents(connection, SID);
    const prefixCount = before.length;
    assert.ok(prefixCount > 0);
    const idsBySeq = new Map(before.map((r) => [r.sequence_num, r.id]));

    // Append two new turns — the prefix bytes stay byte-identical.
    appendFileSync(
      filePath,
      '\n' +
        [
          userMsg('u3', 'a2', 'Thanks!', '2026-01-01T00:00:05.000Z'),
          asstText('a3', 'u3', "You're welcome.", '2026-01-01T00:00:06.000Z'),
        ].join('\n'),
    );

    const logs = await captureLogs(async () => {
      await importer.importTranscript(filePath, { force: true, incremental: true });
    });
    assert.equal(importMode(logs), 'incremental', 'second import should take the incremental path');

    const after = readEvents(connection, SID);
    // Every prefix row keeps its original id at its original sequence_num.
    for (const row of after) {
      if (row.sequence_num < prefixCount) {
        assert.equal(row.id, idsBySeq.get(row.sequence_num), `seq ${row.sequence_num} id changed`);
      }
    }
    // New tail rows were appended above the old prefix.
    assert.ok(after.length > prefixCount, 'tail rows should have been inserted');
    const tail = after.filter((r) => r.sequence_num >= prefixCount);
    assert.ok(tail.length >= 2, 'the two appended turns produced new events');

    connection.closeDb();
  });

  it('Behavior #3a: a prefix-byte change falls back to the full path (data matches cold import)', async () => {
    const modified = [
      userMsg('u1', null, 'Hxllo, read my file.', '2026-01-01T00:00:01.000Z'), // same length, flipped byte
      ...PREFIX_LINES.slice(1),
    ].join('\n');

    // Session under test: full import of the original prefix, then re-import the
    // in-place-rewritten file with the flag on.
    const a = await fresh();
    const filePath = join(TEST_ROOT, 'b3a.jsonl');
    writeFileSync(filePath, PREFIX_LINES.join('\n'));
    await a.importer.importTranscript(filePath);

    writeFileSync(filePath, modified); // rewrite prefix (same size) — validatePrefix fails
    const logs = await captureLogs(async () => {
      await a.importer.importTranscript(filePath, { force: true, incremental: true });
    });
    assert.equal(importMode(logs), 'full', 'prefix rewrite must fall back to the full path');
    const fallbackRows = withoutId(readEvents(a.connection, SID));
    a.connection.closeDb();

    // Cold import of the modified file into a fresh DB.
    const b = await fresh();
    const coldFile = join(TEST_ROOT, 'b3a-cold.jsonl');
    writeFileSync(coldFile, modified);
    await b.importer.importTranscript(coldFile);
    const coldRows = withoutId(readEvents(b.connection, SID));
    b.connection.closeDb();

    assert.deepEqual(fallbackRows, coldRows, 'fallback data should equal a cold import');
  });

  it('Behavior #3b: a file shrink falls back to the full path (data matches cold import)', async () => {
    const shrunk = PREFIX_LINES.slice(0, 2).join('\n'); // drop the tail → smaller than checkpoint

    const a = await fresh();
    const filePath = join(TEST_ROOT, 'b3b.jsonl');
    writeFileSync(filePath, PREFIX_LINES.join('\n'));
    await a.importer.importTranscript(filePath);

    writeFileSync(filePath, shrunk); // shrink — validatePrefix fails (size < checkpoint)
    const logs = await captureLogs(async () => {
      await a.importer.importTranscript(filePath, { force: true, incremental: true });
    });
    assert.equal(importMode(logs), 'full', 'a shrunk file must fall back to the full path');
    const fallbackRows = withoutId(readEvents(a.connection, SID));
    a.connection.closeDb();

    const b = await fresh();
    const coldFile = join(TEST_ROOT, 'b3b-cold.jsonl');
    writeFileSync(coldFile, shrunk);
    await b.importer.importTranscript(coldFile);
    const coldRows = withoutId(readEvents(b.connection, SID));
    b.connection.closeDb();

    assert.deepEqual(fallbackRows, coldRows, 'fallback data should equal a cold import');
  });

  it('Behavior #4: a transcript truncated mid-tool-call, then completed, matches a cold import', async () => {
    // Truncated: ends right after the tool_use with no tool_result yet.
    const truncated = [
      userMsg('u1', null, 'Hello, read my file.', '2026-01-01T00:00:01.000Z'),
      asstToolUse('a1', 'u1', '2026-01-01T00:00:02.000Z'),
    ];
    const resultLine = toolResult('u2', 'a1', '2026-01-01T00:00:03.000Z');

    // Incremental session: import truncated, then append the tool_result.
    const a = await fresh();
    const filePath = join(TEST_ROOT, 'b4.jsonl');
    writeFileSync(filePath, truncated.join('\n'));
    await a.importer.importTranscript(filePath);

    // The bare tool_call_start has no output/duration yet.
    const boundaryBefore = readEvents(a.connection, SID).find((r) => r.tool_name === 'Read');
    assert.ok(boundaryBefore, 'tool_call_start should exist after truncated import');
    assert.equal(boundaryBefore.output_data, null);
    assert.equal(boundaryBefore.duration_ms, null);

    appendFileSync(filePath, '\n' + resultLine);
    const logs = await captureLogs(async () => {
      await a.importer.importTranscript(filePath, { force: true, incremental: true });
    });
    assert.equal(importMode(logs), 'incremental', 'completing the tool call should take the incremental path');
    const incrementalRows = withoutId(readEvents(a.connection, SID));
    const boundaryAfter = readEvents(a.connection, SID).find((r) => r.tool_name === 'Read');
    a.connection.closeDb();

    // Cold import of the fully-completed file.
    const b = await fresh();
    const coldFile = join(TEST_ROOT, 'b4-cold.jsonl');
    writeFileSync(coldFile, [...truncated, resultLine].join('\n'));
    await b.importer.importTranscript(coldFile);
    const coldRows = withoutId(readEvents(b.connection, SID));
    const coldBoundary = readEvents(b.connection, SID).find((r) => r.tool_name === 'Read');
    b.connection.closeDb();

    assert.ok(boundaryAfter && coldBoundary);
    assert.ok(boundaryAfter.output_data, 'completed tool event has output_data');
    assert.equal(boundaryAfter.output_data, coldBoundary.output_data);
    assert.equal(boundaryAfter.duration_ms, coldBoundary.duration_ms);
    assert.equal(boundaryAfter.agent_id, coldBoundary.agent_id);
    assert.deepEqual(incrementalRows, coldRows, 'completed session should equal a cold import');
  });

  it('Behavior #8: an injected wrong intermediate write self-heals, warns, and matches a cold import', async () => {
    const APPEND =
      '\n' +
      [
        userMsg('u3', 'a2', 'Thanks!', '2026-01-01T00:00:05.000Z'),
        asstText('a3', 'u3', "You're welcome.", '2026-01-01T00:00:06.000Z'),
      ].join('\n');

    // Incremental session: cold import the prefix, append, then re-import
    // incrementally WITH the fault hook on so the parent block is written wrong.
    const a = await fresh();
    const filePath = join(TEST_ROOT, 'b8.jsonl');
    writeFileSync(filePath, PREFIX_LINES.join('\n'));
    await a.importer.importTranscript(filePath);
    appendFileSync(filePath, APPEND);

    let logs: string[] = [];
    a.importer.__setIncrementalWriteFaultForTest(true);
    try {
      logs = await captureLogs(async () => {
        await a.importer.importTranscript(filePath, { force: true, incremental: true });
      });
    } finally {
      a.importer.__setIncrementalWriteFaultForTest(false);
    }

    // (a) the self-heal warn fired, and (b) the timing log records the heal.
    assert.ok(
      logs.some((l) => l.includes('[WARN]') && l.includes('Incremental import self-heal')),
      'self-heal should log a warn',
    );
    assert.equal(importMode(logs), 'incremental-healed', 'timing log should record the heal');

    const healedRows = withoutId(readEvents(a.connection, SID));
    const healedSession = readSessionAggregates(a.connection, SID);
    a.connection.closeDb();

    // (c) the final DB equals a cold full re-import of the same final file.
    const b = await fresh();
    const coldFile = join(TEST_ROOT, 'b8-cold.jsonl');
    writeFileSync(coldFile, PREFIX_LINES.join('\n') + APPEND);
    await b.importer.importTranscript(coldFile);
    const coldRows = withoutId(readEvents(b.connection, SID));
    const coldSession = readSessionAggregates(b.connection, SID);
    b.connection.closeDb();

    assert.deepEqual(healedRows, coldRows, 'healed events should equal a cold import');
    assert.deepEqual(healedSession, coldSession, 'healed session aggregates should equal a cold import');
  });

  it('Behavior #8 (negative): a correct incremental write does not spuriously self-heal', async () => {
    const APPEND =
      '\n' +
      [
        userMsg('u3', 'a2', 'Thanks!', '2026-01-01T00:00:05.000Z'),
        asstText('a3', 'u3', "You're welcome.", '2026-01-01T00:00:06.000Z'),
      ].join('\n');

    const a = await fresh();
    const filePath = join(TEST_ROOT, 'b8n.jsonl');
    writeFileSync(filePath, PREFIX_LINES.join('\n'));
    await a.importer.importTranscript(filePath);
    appendFileSync(filePath, APPEND);

    // Hook OFF (default) — the same append must NOT trigger the self-heal.
    const logs = await captureLogs(async () => {
      await a.importer.importTranscript(filePath, { force: true, incremental: true });
    });
    a.connection.closeDb();

    assert.equal(importMode(logs), 'incremental', 'a correct write stays plain incremental');
    assert.ok(
      !logs.some((l) => l.includes('Incremental import self-heal')),
      'no self-heal warn on a correct incremental write',
    );
  });

  it('Behavior #1b: two successive incremental appends each stay incremental and match a cold import', async () => {
    // The watcher re-imports the same growing file on every tick. This exercises
    // that multi-tick loop: the checkpoint written by the first incremental import
    // must advance so the second append validates against the new prefix offset
    // (rather than re-inserting the first tail as duplicate rows).
    const APPEND_1 =
      '\n' +
      [
        userMsg('u3', 'a2', 'Thanks!', '2026-01-01T00:00:05.000Z'),
        asstText('a3', 'u3', "You're welcome.", '2026-01-01T00:00:06.000Z'),
      ].join('\n');
    const APPEND_2 =
      '\n' +
      [
        userMsg('u5', 'a3', 'One more thing.', '2026-01-01T00:00:07.000Z'),
        asstText('a5', 'u5', 'Sure thing.', '2026-01-01T00:00:08.000Z'),
      ].join('\n');

    const a = await fresh();
    const filePath = join(TEST_ROOT, 'b1b.jsonl');
    writeFileSync(filePath, PREFIX_LINES.join('\n'));
    await a.importer.importTranscript(filePath); // cold seed

    appendFileSync(filePath, APPEND_1);
    const logs1 = await captureLogs(async () => {
      await a.importer.importTranscript(filePath, { force: true, incremental: true });
    });
    assert.equal(importMode(logs1), 'incremental', 'first append is incremental');

    appendFileSync(filePath, APPEND_2);
    const logs2 = await captureLogs(async () => {
      await a.importer.importTranscript(filePath, { force: true, incremental: true });
    });
    assert.equal(importMode(logs2), 'incremental', 'second append is also incremental (checkpoint advanced)');

    const incrementalRows = withoutId(readEvents(a.connection, SID));
    a.connection.closeDb();

    // Cold import of the twice-appended final file into a fresh DB.
    const b = await fresh();
    const coldFile = join(TEST_ROOT, 'b1b-cold.jsonl');
    writeFileSync(coldFile, PREFIX_LINES.join('\n') + APPEND_1 + APPEND_2);
    await b.importer.importTranscript(coldFile);
    const coldRows = withoutId(readEvents(b.connection, SID));
    b.connection.closeDb();

    assert.deepEqual(incrementalRows, coldRows, 'two incremental ticks equal a single cold import (no duplicates)');
  });
});
