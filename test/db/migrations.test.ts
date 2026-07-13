import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

/**
 * Migration 017 adds sessions.cost_estimate_usd and then backfills it for every
 * existing session (rows the column add leaves NULL). These tests drive that
 * backfill through the public runMigrations() entrypoint: build a fully-migrated
 * DB, seed rows, then delete the id-17 marker and re-run so migration 017
 * re-applies (the guarded column adds no-op; the backfill runs).
 */
describe('migration 017 — cost backfill', () => {
  let db: Database.Database;

  afterEach(() => db?.close());

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

  function reapplyCostMigration(d: Database.Database): void {
    d.prepare('DELETE FROM _migrations WHERE id = 17').run();
    runMigrations(d);
  }

  function costOf(d: Database.Database, id: string): number | null {
    return (d.prepare('SELECT cost_estimate_usd c FROM sessions WHERE id = ?').get(id) as {
      c: number | null;
    }).c;
  }

  it('prices a NULL-cost session from its stored aggregate columns', () => {
    db = freshDb();
    // A pre-feature import: cost NULL, billed/5m/1h zero (predate migration 016),
    // but cache-read / cache-write / output present. Cache writes price at the
    // default TTL rate via the cacheWriteDefault residual.
    insertSession(db, {
      id: 's1',
      model: 'claude-sonnet-4-6',
      status: 'imported',
      total_input_tokens_billed: 0,
      total_cache_read_tokens: 4191629,
      total_cache_write_tokens: 245135,
      total_cache_write_5m_tokens: 0,
      total_cache_write_1h_tokens: 0,
      total_output_tokens: 36525,
      cost_estimate_usd: null,
    });

    reapplyCostMigration(db);

    // 4191629*0.3 + 245135*3.75 + 36525*15, all /1e6 → 2.72462
    const cost = costOf(db, 's1');
    assert.ok(cost !== null);
    assert.ok(Math.abs((cost as number) - 2.72462) < 1e-5, `expected ~2.72462, got ${cost}`);
  });

  it('subtracts sub-agent output so parent output is not double-counted', () => {
    db = freshDb();
    // total_output_tokens (100000) was inflated at import to include the agent's
    // 40000 output. The backfill must price the parent on 60000 (parent-only).
    insertSession(db, {
      id: 's2',
      model: 'claude-sonnet-4-6',
      total_input_tokens_billed: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_output_tokens: 100000,
      cost_estimate_usd: null,
    });
    db.prepare(
      `INSERT INTO agent_relationships
         (parent_session_id, child_agent_id, model, input_tokens_total, output_tokens_total,
          cache_read_total, cache_write_5m_total, cache_write_1h_total)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0)`,
    ).run('s2', 'agent-1', null, 1000, 40000);

    reapplyCostMigration(db);

    // parent: 60000*15/1e6 = 0.9 ; agent (falls back to parent model):
    //   1000*3/1e6 + 40000*15/1e6 = 0.003 + 0.6 = 0.603 ; total = 1.503
    // (without the subtraction it would be 1.5 + 0.603 = 2.103)
    const cost = costOf(db, 's2');
    assert.ok(cost !== null);
    assert.ok(Math.abs((cost as number) - 1.503) < 1e-5, `expected ~1.503, got ${cost}`);
  });

  it('never overwrites an import-computed cost', () => {
    db = freshDb();
    insertSession(db, {
      id: 's3',
      model: 'claude-sonnet-4-6',
      total_cache_read_tokens: 4191629,
      total_output_tokens: 36525,
      cost_estimate_usd: 1.23, // already priced at import — must be preserved
    });

    reapplyCostMigration(db);

    assert.equal(costOf(db, 's3'), 1.23);
  });

  it('leaves cost NULL when the model cannot be resolved', () => {
    db = freshDb();
    insertSession(db, {
      id: 's4',
      model: '<synthetic>',
      total_cache_read_tokens: 1000,
      total_output_tokens: 1000,
      cost_estimate_usd: null,
    });

    reapplyCostMigration(db);

    assert.equal(costOf(db, 's4'), null);
  });
});

/**
 * Migrations 016 (cache-write split) and 017 (cost + agent model) add columns to
 * a pre-existing agent_relationships table. On a fresh DB those columns already
 * exist in INITIAL_SCHEMA, so the guarded ADD COLUMN branches never run. This
 * drives the genuine legacy-upgrade path: a DB whose agent_relationships predates
 * those columns, with migrations 1–15 already marked applied, so runMigrations
 * executes 016/017's column adds against the legacy shape.
 */
describe('migrations 016/017 — legacy agent_relationships upgrade', () => {
  let db: Database.Database;

  afterEach(() => db?.close());

  function hasColumn(d: Database.Database, table: string, column: string): boolean {
    const rows = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === column);
  }

  it('adds the cache-total and model columns to a legacy agent_relationships table', () => {
    db = new Database(':memory:');
    // Legacy schema: agent_relationships without the cache-total / model columns
    // and sessions without the migration-016/017 aggregate columns.
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        model TEXT,
        total_cache_read_tokens INTEGER DEFAULT 0,
        total_cache_write_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0
      );
      CREATE TABLE agent_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_session_id TEXT NOT NULL,
        child_agent_id TEXT NOT NULL,
        input_tokens_total INTEGER,
        output_tokens_total INTEGER
      );
      CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Mark migrations 1–15 applied so runMigrations only runs 016/017/018.
    const stamp = db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)');
    for (let i = 1; i <= 15; i++) stamp.run(i, `legacy-${i}`);

    db.prepare(
      'INSERT INTO sessions (id, project_path, started_at, model, total_cache_read_tokens, total_output_tokens) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('legacy-1', '/p', '2025-01-01T00:00:00.000Z', 'claude-sonnet-4-6', 1000, 1000);

    runMigrations(db);

    // The guarded ADD COLUMN branches in 016/017 ran against the legacy shape.
    for (const col of ['cache_read_total', 'cache_write_5m_total', 'cache_write_1h_total', 'model']) {
      assert.ok(hasColumn(db, 'agent_relationships', col), `agent_relationships.${col} added`);
    }
    assert.ok(hasColumn(db, 'sessions', 'total_input_tokens_billed'), 'sessions.total_input_tokens_billed added');
    assert.ok(hasColumn(db, 'sessions', 'cost_estimate_usd'), 'sessions.cost_estimate_usd added');
    // 017's backfill priced the seeded session through the (now-complete) columns.
    const cost = (db.prepare('SELECT cost_estimate_usd c FROM sessions WHERE id = ?').get('legacy-1') as { c: number | null }).c;
    assert.ok(cost !== null && cost > 0, `expected a backfilled cost, got ${cost}`);
  });
});
