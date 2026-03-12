import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';

describe('Stats route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stats-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    const db = getDb(dbPath);

    const insertSession = db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count,
        duration_ms, risk_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertSession.run('sess-1', '/tmp/a', 'completed', '2026-01-15T10:00:00Z', 5000, 3000, 1000, 500, 2, 10, 1, 1800000, 0.4);
    insertSession.run('sess-2', '/tmp/b', 'completed', '2026-01-16T10:00:00Z', 8000, 4000, 2000, 800, 0, 15, 3, 3600000, 0.7);

    // Insert some events
    db.prepare(`
      INSERT INTO events (session_id, event_type, event_source, timestamp, sequence_num)
      VALUES (?, ?, ?, ?, ?)
    `).run('sess-1', 'tool_call_start', 'hook', '2026-01-15T10:01:00Z', 1);

    app = createApp();
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns aggregate stats', async () => {
    const res = await app.request('/api/stats');
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.session_count, 2);
    assert.equal(body.event_count, 1);
    assert.equal(body.total_input_tokens, 13000);
    assert.equal(body.total_output_tokens, 7000);
    assert.equal(body.total_cache_read_tokens, 3000);
    assert.equal(body.total_cache_write_tokens, 1300);
    assert.equal(body.avg_duration_ms, 2700000);
    assert.equal(body.avg_risk_score, 0.55);
    assert.equal(body.total_compactions, 2);
    assert.equal(body.total_tool_calls, 25);
    assert.equal(body.total_subagents, 4);
    assert.equal(body.sessions_with_compactions, 1);
    assert.equal(body.oldest_session, '2026-01-15T10:00:00Z');
    assert.equal(body.newest_session, '2026-01-16T10:00:00Z');
    assert.equal(typeof body.db_size_bytes, 'number');
  });

  it('includes total_cost_estimate_usd', async () => {
    const res = await app.request('/api/stats');
    const body = await res.json();
    assert.equal(typeof body.total_cost_estimate_usd, 'number');
    assert.ok(body.total_cost_estimate_usd >= 0);
  });

  it('calculates cost correctly across models', async () => {
    // sess-1 has model null (from insert), sess-2 has model null
    // Insert sessions with known models for cost verification
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at, model,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count,
        duration_ms, risk_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-cost-1', '/tmp/c', 'completed', '2026-01-17T10:00:00Z',
      'claude-sonnet-4-20250514', 1000000, 500000, 0, 0, 0, 0, 0, 1000, 0.1);
    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at, model,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count,
        duration_ms, risk_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-cost-2', '/tmp/d', 'completed', '2026-01-17T11:00:00Z',
      'claude-opus-4-20250514', 1000000, 500000, 0, 0, 0, 0, 0, 2000, 0.2);

    const res = await app.request('/api/stats');
    const body = await res.json();

    // Sonnet: (1M/1M)*3 + (500K/1M)*15 = 3 + 7.5 = 10.5
    // Opus: (1M/1M)*15 + (500K/1M)*75 = 15 + 37.5 = 52.5
    // Total from these two: 63.0 (plus whatever the original 2 sessions contribute)
    assert.ok(body.total_cost_estimate_usd >= 63.0);

    // Cleanup
    db.prepare('DELETE FROM sessions WHERE id IN (?, ?)').run('sess-cost-1', 'sess-cost-2');
  });
});
