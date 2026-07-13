import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import { repriceAllSessions } from '../../src/analysis/reprice.js';
import { setDiscountRules } from '../../src/shared/cost.js';

/**
 * End-to-end retroactive reprice: a per-model, time-bounded discount rule
 * scales an in-window session's stored cost_estimate_usd, leaves an
 * out-of-window session untouched, and the `/api/stats` aggregate
 * (total_cost_estimate_usd = SUM(cost_estimate_usd)) reflects the discount.
 */
describe('Discount reprice (end-to-end)', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  const insertSession = (
    db: ReturnType<typeof getDb>,
    id: string,
    model: string,
    startedAt: string,
  ): void => {
    db.prepare(
      `INSERT INTO sessions
         (id, project_path, status, started_at, model,
          total_input_tokens_billed, total_cache_read_tokens, total_cache_write_tokens,
          total_cache_write_5m_tokens, total_cache_write_1h_tokens, total_output_tokens,
          cost_estimate_usd)
       VALUES (?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, `/tmp/${id}`, startedAt, model, 100_000, 200_000, 50_000, 50_000, 0, 80_000, null);
  };

  const costOf = (db: ReturnType<typeof getDb>, id: string): number =>
    (db.prepare('SELECT cost_estimate_usd c FROM sessions WHERE id = ?').get(id) as {
      c: number;
    }).c;

  const statsTotal = async (): Promise<number> => {
    const res = await app.request('/api/stats');
    assert.equal(res.status, 200);
    return (await res.json()).total_cost_estimate_usd as number;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'discount-reprice-'));
    const db = getDb(join(tmpDir, 'test.sqlite'));

    // Same model; one session dated INSIDE the discount window, one OUTSIDE it.
    insertSession(db, 'in-window', 'claude-sonnet-4-6', '2025-06-15T00:00:00.000Z');
    insertSession(db, 'out-window', 'claude-sonnet-4-6', '2025-01-01T00:00:00.000Z');

    app = createApp();
  });

  afterEach(() => {
    setDiscountRules([]); // don't leak module state into other suites
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discounts the in-window session, leaves the out-of-window one, and the stats total reflects it', async () => {
    const db = getDb();

    // Baseline: no rules → list price for both sessions.
    repriceAllSessions(db);
    const listIn = costOf(db, 'in-window');
    const listOut = costOf(db, 'out-window');
    const listTotal = await statsTotal();
    assert.ok(listIn > 0 && listOut > 0);
    // Both sessions are identical apart from date, so their list prices match.
    assert.ok(Math.abs(listIn - listOut) < 1e-9);
    assert.ok(Math.abs(listTotal - (listIn + listOut)) < 1e-5);

    // Apply a 40%-off Sonnet rule for June 2025 and reprice history.
    const percentOff = 40;
    const m = 1 - percentOff / 100; // 0.6
    setDiscountRules([
      { model: 'claude-sonnet-4-6', percentOff, start: '2025-06-01', end: '2025-06-30' },
    ]);
    const { repriced } = repriceAllSessions(db);
    assert.equal(repriced, 2);

    const discIn = costOf(db, 'in-window');
    const discOut = costOf(db, 'out-window');

    // In-window session scales by m (per-type round6 rounding epsilon allowed).
    assert.ok(
      Math.abs(discIn - listIn * m) < 1e-5,
      `expected ${listIn * m}, got ${discIn}`,
    );
    // Out-of-window session is untouched.
    assert.equal(discOut, listOut);

    // The /api/stats aggregate reflects the discount: it dropped by exactly the
    // in-window session's savings and equals the new sum of stored costs.
    const discTotal = await statsTotal();
    assert.ok(
      Math.abs(discTotal - (discIn + discOut)) < 1e-5,
      `stats total ${discTotal} != sum ${discIn + discOut}`,
    );
    assert.ok(
      Math.abs(discTotal - (listTotal - listIn * (1 - m))) < 1e-5,
      `stats total ${discTotal} did not drop by the in-window discount`,
    );
    assert.ok(discTotal < listTotal);
  });
});
