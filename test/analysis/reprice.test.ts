import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import { repriceAllSessions } from '../../src/analysis/reprice.js';
import { sessionCostUsd, setDiscountRules } from '../../src/shared/cost.js';

/**
 * repriceAllSessions retroactively rewrites every session's cost_estimate_usd
 * from its stored token columns, date-aware, applying whatever discount rules
 * are loaded. With no rules it's a value-preserving no-op (list price); with a
 * rule it scales in-window sessions and leaves out-of-window/other-model ones
 * unchanged.
 */
describe('repriceAllSessions', () => {
  let db: Database.Database;

  afterEach(() => {
    setDiscountRules([]); // don't leak module state into other test files
    db?.close();
  });

  function freshDb(): Database.Database {
    const d = new Database(':memory:');
    runMigrations(d);
    return d;
  }

  function insertSession(d: Database.Database, cols: Record<string, unknown>): void {
    const full = { project_path: '/p', started_at: '2025-01-01T00:00:00.000Z', ...cols };
    const keys = Object.keys(full);
    d.prepare(
      `INSERT INTO sessions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    ).run(...keys.map((k) => full[k]));
  }

  function costOf(d: Database.Database, id: string): number | null {
    return (d.prepare('SELECT cost_estimate_usd c FROM sessions WHERE id = ?').get(id) as {
      c: number | null;
    }).c;
  }

  it('no rules → repriced cost equals the list-price sessionCostUsd, and counts updated rows', () => {
    db = freshDb();

    // A session with a sub-agent. total_output_tokens (100000) is inflated at
    // import to include the agent's 40000 output, so the parent prices on 60000.
    insertSession(db, {
      id: 's1',
      model: 'claude-sonnet-4-6',
      started_at: '2025-06-15T00:00:00.000Z',
      total_input_tokens_billed: 5000,
      total_cache_read_tokens: 4191629,
      total_cache_write_tokens: 245135,
      total_cache_write_5m_tokens: 200000,
      total_cache_write_1h_tokens: 30000,
      total_output_tokens: 100000,
      cost_estimate_usd: null,
    });
    db.prepare(
      `INSERT INTO agent_relationships
         (parent_session_id, child_agent_id, model, input_tokens_total, output_tokens_total,
          cache_read_total, cache_write_5m_total, cache_write_1h_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('s1', 'agent-1', 'claude-haiku-4-5', 1000, 40000, 2000, 500, 0);

    // A second, agent-free session.
    insertSession(db, {
      id: 's2',
      model: 'claude-opus-4-8',
      started_at: '2025-06-15T00:00:00.000Z',
      total_input_tokens_billed: 12345,
      total_cache_read_tokens: 6789,
      total_cache_write_tokens: 50000,
      total_cache_write_5m_tokens: 50000,
      total_cache_write_1h_tokens: 0,
      total_output_tokens: 20000,
      cost_estimate_usd: null,
    });

    const { repriced } = repriceAllSessions(db);
    assert.equal(repriced, 2);

    // Expected s1 = parent (Sonnet, parent-only output 60000) + agent (Haiku).
    const expectedS1 = sessionCostUsd(
      'claude-sonnet-4-6',
      {
        freshInput: 5000,
        cacheRead: 4191629,
        cacheWrite5m: 200000,
        cacheWrite1h: 30000,
        cacheWriteDefault: 245135 - 200000 - 30000,
        output: 100000 - 40000,
      },
      [
        {
          model: 'claude-haiku-4-5',
          freshInput: 1000,
          cacheRead: 2000,
          cacheWrite5m: 500,
          cacheWrite1h: 0,
          output: 40000,
        },
      ],
    );
    const expectedS2 = sessionCostUsd(
      'claude-opus-4-8',
      {
        freshInput: 12345,
        cacheRead: 6789,
        cacheWrite5m: 50000,
        cacheWrite1h: 0,
        cacheWriteDefault: 0,
        output: 20000,
      },
      [],
    );

    assert.ok(expectedS1 !== null && expectedS2 !== null);
    assert.equal(costOf(db, 's1'), expectedS1);
    assert.equal(costOf(db, 's2'), expectedS2);
  });

  it('with a rule, scales the in-window session by m and leaves out-of-window / other-model unchanged', () => {
    db = freshDb();

    // In-window Sonnet session.
    insertSession(db, {
      id: 'inWindow',
      model: 'claude-sonnet-4-6',
      started_at: '2025-06-15T00:00:00.000Z',
      total_input_tokens_billed: 100000,
      total_cache_read_tokens: 200000,
      total_cache_write_tokens: 50000,
      total_cache_write_5m_tokens: 50000,
      total_cache_write_1h_tokens: 0,
      total_output_tokens: 80000,
      cost_estimate_usd: null,
    });
    // Same model, but started_at is outside the discount window.
    insertSession(db, {
      id: 'outWindow',
      model: 'claude-sonnet-4-6',
      started_at: '2025-01-01T00:00:00.000Z',
      total_input_tokens_billed: 100000,
      total_cache_read_tokens: 200000,
      total_cache_write_tokens: 50000,
      total_cache_write_5m_tokens: 50000,
      total_cache_write_1h_tokens: 0,
      total_output_tokens: 80000,
      cost_estimate_usd: null,
    });
    // In-window date but a different model — the rule doesn't apply.
    insertSession(db, {
      id: 'otherModel',
      model: 'claude-opus-4-8',
      started_at: '2025-06-15T00:00:00.000Z',
      total_input_tokens_billed: 100000,
      total_cache_read_tokens: 200000,
      total_cache_write_tokens: 50000,
      total_cache_write_5m_tokens: 50000,
      total_cache_write_1h_tokens: 0,
      total_output_tokens: 80000,
      cost_estimate_usd: null,
    });

    // First, list-price baseline (no rules).
    repriceAllSessions(db);
    const listInWindow = costOf(db, 'inWindow');
    const listOutWindow = costOf(db, 'outWindow');
    const listOtherModel = costOf(db, 'otherModel');
    assert.ok(listInWindow !== null && listOutWindow !== null && listOtherModel !== null);

    // Now apply a 40%-off Sonnet rule for June 2025 and reprice again.
    const percentOff = 40;
    const m = 1 - percentOff / 100; // 0.6
    setDiscountRules([
      { model: 'claude-sonnet-4-6', percentOff, start: '2025-06-01', end: '2025-06-30' },
    ]);
    const { repriced } = repriceAllSessions(db);
    assert.equal(repriced, 3);

    const discInWindow = costOf(db, 'inWindow') as number;
    const discOutWindow = costOf(db, 'outWindow') as number;
    const discOtherModel = costOf(db, 'otherModel') as number;

    // In-window Sonnet scales by m (allow rounding epsilon from per-type round6).
    assert.ok(
      Math.abs(discInWindow - (listInWindow as number) * m) < 1e-5,
      `expected ${(listInWindow as number) * m}, got ${discInWindow}`,
    );
    // Out-of-window and other-model are unchanged.
    assert.equal(discOutWindow, listOutWindow);
    assert.equal(discOtherModel, listOtherModel);
  });
});
