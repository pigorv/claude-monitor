import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

const TMP = join(tmpdir(), `drop-risk-${Date.now()}`);
const DB_PATH = join(TMP, 'drop-risk.sqlite');

describe('migration 011-drop-risk-score', () => {
  let db: Database.Database;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    db = new Database(DB_PATH);
  });

  afterEach(() => {
    db?.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('drops the risk_score column and clears stale risk_signals metadata blobs', () => {
    db.exec(`
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        summary TEXT,
        metadata TEXT,
        risk_score REAL,
        invocations TEXT,
        started_with TEXT
      );
    `);
    // Pre-record migrations 1–10 so only 011 runs.
    for (let i = 1; i <= 10; i++) {
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, `mig-${i}`);
    }
    db.prepare("INSERT INTO sessions (id, summary, metadata, risk_score) VALUES ('s-stale', 'demo', ?, 0.42)").run(
      JSON.stringify({ risk_signals: [{ name: 'context_utilization', value: 0.8 }] }),
    );
    db.prepare("INSERT INTO sessions (id, summary, metadata) VALUES ('s-clean', 'demo', NULL)").run();
    db.prepare("INSERT INTO sessions (id, summary, metadata) VALUES ('s-other', 'demo', ?)").run(
      JSON.stringify({ unrelated: 'preserve me' }),
    );

    runMigrations(db);

    const cols = (db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]).map((r) => r.name);
    assert.ok(!cols.includes('risk_score'), 'risk_score column should be dropped');

    const stale = db.prepare("SELECT metadata FROM sessions WHERE id = 's-stale'").get() as { metadata: string | null };
    assert.equal(stale.metadata, null, 'stale risk_signals metadata should be cleared');

    const clean = db.prepare("SELECT metadata FROM sessions WHERE id = 's-clean'").get() as { metadata: string | null };
    assert.equal(clean.metadata, null, 'already-null metadata should remain null');

    const other = db.prepare("SELECT metadata FROM sessions WHERE id = 's-other'").get() as { metadata: string | null };
    assert.deepEqual(JSON.parse(other.metadata!), { unrelated: 'preserve me' }, 'unrelated metadata should be untouched');

    const applied = db.prepare('SELECT id, name FROM _migrations ORDER BY id').all() as { id: number; name: string }[];
    assert.ok(applied.find((m) => m.id === 11 && m.name === '011-drop-risk-score'), 'migration 11 should be recorded');
  });

  it('is idempotent when risk_score column has already been dropped', () => {
    db.exec(`
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, metadata TEXT, invocations TEXT, started_with TEXT);
    `);
    for (let i = 1; i <= 10; i++) {
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, `mig-${i}`);
    }
    db.prepare("INSERT INTO sessions (id, metadata) VALUES ('s1', ?)").run(
      JSON.stringify({ risk_signals: [{ name: 'x', value: 1 }] }),
    );

    // Should not throw — tableHasColumn guard returns false, DROP COLUMN is skipped,
    // metadata clear still runs.
    runMigrations(db);

    const row = db.prepare("SELECT metadata FROM sessions WHERE id = 's1'").get() as { metadata: string | null };
    assert.equal(row.metadata, null);
  });
});
