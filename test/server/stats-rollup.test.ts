import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';

// Seed a small, exactly-predictable set of sessions so the rollup sums are
// known constants. One session has a compaction, one does not, and one has a
// NULL duration_ms (so avg_duration_ms is proven to be over non-null rows).
const SESS = {
  // id       input  output cacheR cacheW comp tools sub  duration   cost   started
  a: { id: 'sess-a', input: 5000, output: 3000, cacheR: 1000, cacheW: 500, comp: 2, tools: 10, sub: 1, duration: 1800000, cost: 10.5, started: '2026-01-15T10:00:00Z' },
  b: { id: 'sess-b', input: 8000, output: 4000, cacheR: 2000, cacheW: 800, comp: 0, tools: 15, sub: 3, duration: 3600000, cost: 20.0, started: '2026-01-16T10:00:00Z' },
  c: { id: 'sess-c', input: 2000, output: 1000, cacheR: 500, cacheW: 100, comp: 1, tools: 5, sub: 0, duration: null, cost: 5.0, started: '2026-01-14T10:00:00Z' },
} as const;

async function rollup(app: ReturnType<typeof createApp>, session_ids: unknown) {
  return app.request('/api/stats/rollup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_ids }),
  });
}

describe('Stats rollup route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stats-rollup-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    const db = getDb(dbPath);

    const insertSession = db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at, model,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count,
        duration_ms, cost_estimate_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of [SESS.a, SESS.b, SESS.c]) {
      insertSession.run(
        s.id, '/tmp/' + s.id, 'completed', s.started, 'claude-sonnet-4-20250514',
        s.input, s.output, s.cacheR, s.cacheW, s.comp, s.tools, s.sub, s.duration, s.cost,
      );
    }

    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Behavior #1: rollup over a set of known ids returns totals equal to the
  // sum of those sessions' individual stats.
  it('sums totals over a set of known ids (Behavior #1)', async () => {
    const res = await rollup(app, [SESS.a.id, SESS.b.id, SESS.c.id]);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.requested_count, 3);
    assert.equal(body.matched_count, 3);
    assert.equal(body.session_count, 3);
    assert.equal(body.total_input_tokens, 15000);
    assert.equal(body.total_output_tokens, 8000);
    assert.equal(body.total_cache_read_tokens, 3500);
    assert.equal(body.total_cache_write_tokens, 1400);
    assert.equal(body.total_cost_estimate_usd, 35.5);
    // AVG over non-null durations only: (1800000 + 3600000) / 2 (sess-c is NULL)
    assert.equal(body.avg_duration_ms, 2700000);
    assert.equal(body.total_compactions, 3);
    assert.equal(body.total_tool_calls, 30);
    assert.equal(body.total_subagents, 4);
    assert.equal(body.sessions_with_compactions, 2);
    assert.equal(body.oldest_session, '2026-01-14T10:00:00Z');
    assert.equal(body.newest_session, '2026-01-16T10:00:00Z');
  });

  // Behavior #2: passing every session id matches GET /api/stats for the
  // session-derived fields; the rollup omits db_size_bytes/sessions_today/event_count.
  it('matches GET /api/stats over all session ids (Behavior #2)', async () => {
    const statsRes = await app.request('/api/stats');
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();

    const res = await rollup(app, [SESS.a.id, SESS.b.id, SESS.c.id]);
    assert.equal(res.status, 200);
    const body = await res.json();

    for (const field of [
      'total_input_tokens',
      'total_output_tokens',
      'total_cache_read_tokens',
      'total_cache_write_tokens',
      'avg_duration_ms',
      'total_compactions',
      'total_tool_calls',
      'total_subagents',
      'sessions_with_compactions',
      'total_cost_estimate_usd',
      'oldest_session',
      'newest_session',
    ]) {
      assert.equal(body[field], stats[field], `field ${field} should match /api/stats`);
    }

    // Fields present on /api/stats but intentionally absent from the rollup.
    assert.equal(body.db_size_bytes, undefined);
    assert.equal(body.sessions_today, undefined);
    assert.equal(body.event_count, undefined);
  });

  // Behavior #3: empty array → 200 zeroed totals.
  it('returns zeroed 200 for an empty id set (Behavior #3)', async () => {
    const res = await rollup(app, []);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.requested_count, 0);
    assert.equal(body.matched_count, 0);
    assert.equal(body.session_count, 0);
    assert.equal(body.total_input_tokens, 0);
    assert.equal(body.total_output_tokens, 0);
    assert.equal(body.total_cache_read_tokens, 0);
    assert.equal(body.total_cache_write_tokens, 0);
    assert.equal(body.total_cost_estimate_usd, 0);
    assert.equal(body.avg_duration_ms, 0);
    assert.equal(body.total_compactions, 0);
    assert.equal(body.total_tool_calls, 0);
    assert.equal(body.total_subagents, 0);
    assert.equal(body.sessions_with_compactions, 0);
    assert.equal(body.oldest_session, null);
    assert.equal(body.newest_session, null);
  });

  // Behavior #4: all-unknown ids → zeroed 200 with requested_count = distinct count.
  it('returns zeroed 200 for all-unknown ids (Behavior #4)', async () => {
    const res = await rollup(app, ['nope-1', 'nope-2']);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.requested_count, 2);
    assert.equal(body.matched_count, 0);
    assert.equal(body.session_count, 0);
    assert.equal(body.total_input_tokens, 0);
    assert.equal(body.total_output_tokens, 0);
    assert.equal(body.total_cache_read_tokens, 0);
    assert.equal(body.total_cache_write_tokens, 0);
    assert.equal(body.total_cost_estimate_usd, 0);
    assert.equal(body.avg_duration_ms, 0);
    assert.equal(body.total_compactions, 0);
    assert.equal(body.total_tool_calls, 0);
    assert.equal(body.total_subagents, 0);
    assert.equal(body.sessions_with_compactions, 0);
    assert.equal(body.oldest_session, null);
    assert.equal(body.newest_session, null);
  });

  // Behavior #5: mixed known/unknown → totals only the known one; matched < requested.
  it('totals only the known ids in a mixed set (Behavior #5)', async () => {
    const res = await rollup(app, [SESS.a.id, 'nope']);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.requested_count, 2);
    assert.equal(body.matched_count, 1);
    assert.ok(body.matched_count < body.requested_count);
    assert.equal(body.session_count, 1);
    // Only sess-a's figures.
    assert.equal(body.total_input_tokens, SESS.a.input);
    assert.equal(body.total_output_tokens, SESS.a.output);
    assert.equal(body.total_cache_read_tokens, SESS.a.cacheR);
    assert.equal(body.total_cache_write_tokens, SESS.a.cacheW);
    assert.equal(body.total_cost_estimate_usd, SESS.a.cost);
    assert.equal(body.avg_duration_ms, SESS.a.duration);
    assert.equal(body.total_compactions, SESS.a.comp);
    assert.equal(body.total_tool_calls, SESS.a.tools);
    assert.equal(body.total_subagents, SESS.a.sub);
    assert.equal(body.sessions_with_compactions, 1);
    assert.equal(body.oldest_session, SESS.a.started);
    assert.equal(body.newest_session, SESS.a.started);
  });

  // De-duplication: repeated ids collapse to a distinct requested_count.
  it('de-duplicates repeated ids', async () => {
    const res = await rollup(app, [SESS.a.id, SESS.a.id, SESS.a.id]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.requested_count, 1);
    assert.equal(body.matched_count, 1);
    assert.equal(body.total_input_tokens, SESS.a.input);
  });

  // Behavior #6: malformed bodies → 400 actionable.
  it('returns 400 for a non-JSON body (Behavior #6)', async () => {
    const res = await app.request('/api/stats/rollup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
  });

  it('returns 400 when session_ids is missing (Behavior #6)', async () => {
    const res = await app.request('/api/stats/rollup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
  });

  it('returns 400 when session_ids is not an array (Behavior #6)', async () => {
    const res = await rollup(app, 'abc');
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
  });

  // Behavior #7: a non-string element → 400 actionable.
  it('returns 400 for a non-string element in session_ids (Behavior #7)', async () => {
    const res = await rollup(app, ['ok', 123]);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.equal(typeof body.message, 'string');
  });

  // Behavior #8: a set larger than the SQLite bound-parameter ceiling is
  // chunked and merged — no throw, no truncation.
  it('chunks and merges an id set larger than 32,766 ids (Behavior #8)', async () => {
    const unknown = Array.from({ length: 32770 }, (_, i) => 'x-' + i);
    const res = await rollup(app, [...unknown, SESS.a.id, SESS.b.id]);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.requested_count, 32772);
    assert.equal(body.matched_count, 2);
    assert.equal(body.session_count, 2);
    // Totals equal sess-a + sess-b only.
    assert.equal(body.total_input_tokens, SESS.a.input + SESS.b.input);
    assert.equal(body.total_output_tokens, SESS.a.output + SESS.b.output);
    assert.equal(body.total_cache_read_tokens, SESS.a.cacheR + SESS.b.cacheR);
    assert.equal(body.total_cache_write_tokens, SESS.a.cacheW + SESS.b.cacheW);
    assert.equal(body.total_cost_estimate_usd, SESS.a.cost + SESS.b.cost);
    assert.equal(body.avg_duration_ms, Math.round((SESS.a.duration + SESS.b.duration) / 2));
    assert.equal(body.total_compactions, SESS.a.comp + SESS.b.comp);
    assert.equal(body.total_tool_calls, SESS.a.tools + SESS.b.tools);
    assert.equal(body.total_subagents, SESS.a.sub + SESS.b.sub);
    assert.equal(body.sessions_with_compactions, 1);
    assert.equal(body.oldest_session, SESS.a.started);
    assert.equal(body.newest_session, SESS.b.started);
  });
});
