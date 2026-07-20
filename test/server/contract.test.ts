import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';

// ── Structural shape fingerprint ────────────────────────────────────────
//
// Reduces a response body to its *structure* (types + object keys) and never
// its values. Object keys are sorted so key ordering never churns the snapshot;
// `null` maps to the literal 'null'; arrays become a single-element shape of
// their first item (or [] when empty); primitives collapse to their `typeof`.
//
// The upshot: VERSION, node_version, platform, db_path, db_size_bytes,
// timestamps, and generated filenames are all invisible, so snapshots stay
// deterministic across machines and dates. This helper is intentionally
// dependency-free — no ajv / zod / json-schema.
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = shapeOf((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return typeof value; // 'string' | 'number' | 'boolean'
}

// ── Deterministic seed ──────────────────────────────────────────────────
//
// Built in full here (later contract tasks reuse it):
//   sess-rich   — priced model + populated token columns (costs resolve),
//                 ≥2 agent_relationships (agent_efficiency non-null), several
//                 events, and one session_links row (linked_sessions present).
//                 Latest started_at so it lands first in the default DESC list,
//                 fixing the array-element shape of /api/sessions.
//   sess-bare   — no events / agents / links (minimal detail shape).
//   sess-export — transcript_path points at a real .jsonl file on disk.
const PRICED_MODEL = 'claude-sonnet-4-20250514';

function seed(dbPath: string, tmpDir: string): void {
  const db = getDb(dbPath);

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, project_path, project_name, model, models_used, source, status,
      started_at, ended_at, duration_ms, total_input_tokens, total_output_tokens,
      total_cache_read_tokens, total_cache_write_tokens, total_input_tokens_billed,
      total_cache_write_5m_tokens, total_cache_write_1h_tokens, peak_context_pct,
      compaction_count, tool_call_count, subagent_count, summary, end_reason,
      transcript_path, cost_estimate_usd, invocations, started_with
    ) VALUES (
      @id, @project_path, @project_name, @model, @models_used, @source, @status,
      @started_at, @ended_at, @duration_ms, @total_input_tokens, @total_output_tokens,
      @total_cache_read_tokens, @total_cache_write_tokens, @total_input_tokens_billed,
      @total_cache_write_5m_tokens, @total_cache_write_1h_tokens, @peak_context_pct,
      @compaction_count, @tool_call_count, @subagent_count, @summary, @end_reason,
      @transcript_path, @cost_estimate_usd, @invocations, @started_with
    )
  `);

  // sess-rich — fully populated, latest started_at (lands first in the list).
  insertSession.run({
    id: 'sess-rich',
    project_path: '/home/user/richproj',
    project_name: 'richproj',
    model: PRICED_MODEL,
    models_used: JSON.stringify([PRICED_MODEL, 'claude-haiku-4-5']),
    source: 'startup',
    status: 'completed',
    started_at: '2026-03-03T10:00:00Z',
    ended_at: '2026-03-03T10:45:00Z',
    duration_ms: 2700000,
    total_input_tokens: 12000,
    total_output_tokens: 6000,
    total_cache_read_tokens: 40000,
    total_cache_write_tokens: 9000,
    total_input_tokens_billed: 12000,
    total_cache_write_5m_tokens: 6000,
    total_cache_write_1h_tokens: 3000,
    peak_context_pct: 0.58,
    compaction_count: 1,
    tool_call_count: 8,
    subagent_count: 2,
    summary: 'Implemented the rich fixture',
    end_reason: 'user_exit',
    transcript_path: '/tmp/sess-rich.jsonl',
    cost_estimate_usd: 0.12,
    invocations: JSON.stringify([{ type: 'command', name: 'cm-flow' }]),
    started_with: JSON.stringify({ type: 'command', name: 'cm-flow' }),
  });

  // sess-bare — minimal: no events / agents / links.
  insertSession.run({
    id: 'sess-bare',
    project_path: '/home/user/bareproj',
    project_name: 'bareproj',
    model: PRICED_MODEL,
    models_used: null,
    source: 'startup',
    status: 'imported',
    started_at: '2026-03-01T08:00:00Z',
    ended_at: null,
    duration_ms: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_input_tokens_billed: 0,
    total_cache_write_5m_tokens: 0,
    total_cache_write_1h_tokens: 0,
    peak_context_pct: 0,
    compaction_count: 0,
    tool_call_count: 0,
    subagent_count: 0,
    summary: null,
    end_reason: null,
    transcript_path: null,
    cost_estimate_usd: null,
    invocations: null,
    started_with: null,
  });

  // sess-export — transcript file exists on disk (used by the export route in T1.3).
  const transcriptPath = join(tmpDir, 'sess-export.jsonl');
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
    'utf8',
  );
  insertSession.run({
    id: 'sess-export',
    project_path: '/home/user/exportproj',
    project_name: 'exportproj',
    model: PRICED_MODEL,
    models_used: null,
    source: 'startup',
    status: 'completed',
    started_at: '2026-03-02T09:00:00Z',
    ended_at: '2026-03-02T09:15:00Z',
    duration_ms: 900000,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_input_tokens_billed: 1000,
    total_cache_write_5m_tokens: 0,
    total_cache_write_1h_tokens: 0,
    peak_context_pct: 0.1,
    compaction_count: 0,
    tool_call_count: 1,
    subagent_count: 0,
    summary: 'Exportable session',
    end_reason: 'user_exit',
    transcript_path: transcriptPath,
    cost_estimate_usd: 0.01,
    invocations: null,
    started_with: null,
  });

  // Events for sess-rich (tool calls + a compaction).
  const insertEvent = db.prepare(`
    INSERT INTO events (
      session_id, event_type, event_source, tool_name, timestamp, sequence_num,
      input_tokens, output_tokens, cache_read_tokens, context_pct, duration_ms, input_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertEvent.run('sess-rich', 'tool_call_start', 'transcript_import', 'Read', '2026-03-03T10:01:00Z', 1, 100, 50, 10, 0.1, 200, '{"file_path":"/src/main.ts"}');
  insertEvent.run('sess-rich', 'tool_call_start', 'transcript_import', 'Write', '2026-03-03T10:02:00Z', 2, 200, 100, 20, 0.2, 300, '{"file_path":"/src/out.ts"}');
  insertEvent.run('sess-rich', 'compaction', 'transcript_import', null, '2026-03-03T10:05:00Z', 3, 500, 200, 50, 0.5, null, null);

  // Two non-failed agent_relationships → agent_efficiency becomes non-null.
  const insertAgent = db.prepare(`
    INSERT INTO agent_relationships (
      parent_session_id, child_agent_id, model, input_tokens_total, output_tokens_total,
      cache_read_total, cache_write_5m_total, cache_write_1h_total, status,
      tool_call_count, duration_ms, started_at, ended_at, compression_ratio,
      peak_context_tokens, agent_compaction_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAgent.run('sess-rich', 'agent-1', PRICED_MODEL, 2000, 1000, 1000, 500, 0, 'completed', 4, 60000, '2026-03-03T10:10:00Z', '2026-03-03T10:11:00Z', 3.2, 8000, 0);
  insertAgent.run('sess-rich', 'agent-2', PRICED_MODEL, 1500, 800, 500, 250, 0, 'completed', 3, 45000, '2026-03-03T10:12:00Z', '2026-03-03T10:13:00Z', 2.5, 6000, 0);

  // One session_links row → linked_sessions present on sess-rich detail.
  // Target sess-export (not sess-bare) so sess-bare stays link-free: getLinkedSessions
  // matches both source and target sides, so pointing the link at sess-bare would
  // surface linked_sessions on it too and break the minimal-shape contrast.
  db.prepare(`
    INSERT INTO session_links (source_session_id, target_session_id, link_type)
    VALUES (?, ?, ?)
  `).run('sess-rich', 'sess-export', 'plan_implementation');
}

// ── Populated DB: simple JSON routes ─────────────────────────────────────

describe('API contract: populated DB', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  // Poll the reimport status until the background run reports done. Any test
  // that starts a run MUST await this before returning: otherwise a run still
  // in flight during afterAll's closeDb() reopens getDb() at the *default*
  // (production) db path and scans the real ~/.claude/projects corpus.
  async function waitForReimportDone(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    for (;;) {
      const body = await (await app.request('/api/reimport/status')).json();
      if (body.done) return;
      if (Date.now() - start > timeoutMs) throw new Error('reimport did not finish in time');
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-populated-'));
    seed(join(tmpDir, 'test.sqlite'), tmpDir);
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/health', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/stats (populated)', async () => {
    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('POST /api/stats/rollup (matched)', async () => {
    const res = await app.request('/api/stats/rollup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_ids: ['sess-rich', 'sess-bare'] }),
    });
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('POST /api/stats/rollup (unknown ids, zeroed)', async () => {
    const res = await app.request('/api/stats/rollup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_ids: ['nope-1', 'nope-2'] }),
    });
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/projects', async () => {
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions (populated)', async () => {
    const res = await app.request('/api/sessions');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  // ── Session-scoped JSON routes (T1.2) ─────────────────────────────────
  //
  // sess-rich exhibits the MAXIMAL detail shape: agents populated,
  // agent_efficiency present (≥2 non-failed agents), linked_sessions present
  // (one session_links row), and numeric token_budget costs (priced model).
  // sess-bare exhibits the MINIMAL shape with those optional blocks ABSENT.
  // The contrast between the two snapshots is the contract coverage.

  it('GET /api/sessions/:id (sess-rich, maximal)', async () => {
    const res = await app.request('/api/sessions/sess-rich');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions/:id (sess-bare, minimal)', async () => {
    const res = await app.request('/api/sessions/sess-bare');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions/:id (404)', async () => {
    const res = await app.request('/api/sessions/does-not-exist');
    expect(res.status).toBe(404);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions/:id/events (sess-rich)', async () => {
    const res = await app.request('/api/sessions/sess-rich/events');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions/:id/events (404)', async () => {
    const res = await app.request('/api/sessions/does-not-exist/events');
    expect(res.status).toBe(404);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions/:id/event-counts (sess-rich)', async () => {
    const res = await app.request('/api/sessions/sess-rich/event-counts');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions/:id/event-counts (404)', async () => {
    const res = await app.request('/api/sessions/does-not-exist/event-counts');
    expect(res.status).toBe(404);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  // GET status BEFORE the POST below so it captures the pristine idle shape
  // (startedAt / finishedAt / error all null).
  it('GET /api/reimport/status (idle)', async () => {
    const res = await app.request('/api/reimport/status');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('POST /api/reimport (202)', async () => {
    // The 409 "already running" branch returns the identical body shape
    // ({started, ...status}). The background job scans
    // DEFAULT_CONFIG.claudeProjectsPath and compacts the DB, so it must be
    // awaited to completion before this test returns — an unawaited run in
    // flight during afterAll's closeDb() would reopen getDb() at the default
    // (production) db path and import the real ~/.claude/projects corpus.
    const res = await app.request('/api/reimport', { method: 'POST' });
    expect(res.status).toBe(202);
    expect(shapeOf(await res.json())).toMatchSnapshot();
    await waitForReimportDone();
  });

  it('POST /api/clear without confirm (400)', async () => {
    const res = await app.request('/api/clear', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  // ── Binary export routes (T1.3) ───────────────────────────────────────
  //
  // These two routes return bytes, not JSON, so their contract is the response
  // HEADERS, not a body shape. We snapshot a normalized header descriptor and
  // MASK the volatile date/filename so the snapshot stays date-independent; the
  // raw byte body is never snapshotted. `content_length_numeric` is a boolean so
  // the (volatile) byte count never leaks into the snapshot.
  //
  // NOTE: `POST /api/sessions/:id/open-terminal` is intentionally NOT given a
  // contract test here. It is platform-specific and spawns an OS process, so it
  // has no stable API→SPA response shape to fingerprint; it is already covered by
  // `test/server/terminal.test.ts` and `test/server/terminal-win32.test.ts`.

  it('GET /api/export (headers)', async () => {
    const res = await app.request('/api/export');
    expect(res.status).toBe(200);
    expect({
      status: res.status,
      content_type: res.headers.get('content-type'),
      content_disposition: res.headers.get('content-disposition')!.replace(/\d{4}-\d{2}-\d{2}/, '<DATE>'),
      content_length_numeric:
        Number.isInteger(Number(res.headers.get('content-length'))) &&
        Number(res.headers.get('content-length')) > 0,
    }).toMatchSnapshot();
  });

  it('GET /api/sessions/:id/export (sess-export, headers)', async () => {
    const res = await app.request('/api/sessions/sess-export/export');
    expect(res.status).toBe(200);
    expect({
      status: res.status,
      content_type: res.headers.get('content-type'),
      content_disposition: res.headers.get('content-disposition')!.replace(/\d{4}-\d{2}-\d{2}/, '<DATE>'),
      content_length_numeric:
        Number.isInteger(Number(res.headers.get('content-length'))) &&
        Number(res.headers.get('content-length')) > 0,
    }).toMatchSnapshot();
  });

  it('GET /api/sessions/:id/export (404)', async () => {
    const res = await app.request('/api/sessions/does-not-exist/export');
    expect(res.status).toBe(404);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });
});

// ── Empty DB: /api/stats and /api/sessions ───────────────────────────────
//
// Separate temp DB so the empty-shape assertions never depend on ordering
// against the populated block.

describe('API contract: empty DB', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-empty-'));
    getDb(join(tmpDir, 'test.sqlite'));
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/stats (empty)', async () => {
    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });

  it('GET /api/sessions (empty)', async () => {
    const res = await app.request('/api/sessions');
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });
});

// ── Destructive clear: dedicated throwaway DB ────────────────────────────
//
// Runs against its own temp DB so DELETE-all can't disturb the other blocks.

describe('API contract: clear (destructive)', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'contract-clear-'));
    seed(join(tmpDir, 'test.sqlite'), tmpDir);
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/clear?confirm=true (200)', async () => {
    const res = await app.request('/api/clear?confirm=true', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(shapeOf(await res.json())).toMatchSnapshot();
  });
});
