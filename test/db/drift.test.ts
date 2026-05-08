import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

const TMP = join(tmpdir(), `drift-${Date.now()}`);
const DB_PATH = join(TMP, 'drift.sqlite');

describe('runMigrations drift recovery', () => {
  beforeEach(() => mkdirSync(TMP, { recursive: true }));
  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  it('migration 12 reconciles when ids 10/11 are recorded but invocations columns are missing', () => {
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, metadata TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, event_type TEXT, sequence_num INTEGER, metadata TEXT);
    `);
    for (let i = 1; i <= 11; i++) {
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, i === 10 ? 'old-foo' : i === 11 ? 'old-bar' : `mig-${i}`);
    }
    db.prepare("INSERT INTO sessions (id, summary, metadata) VALUES ('s1', 'demo', NULL)").run();
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, metadata) VALUES ('s1', 'user_message', 1, '{\"command\": \"/review\"}')").run();
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, metadata) VALUES ('s1', 'user_message', 2, '{\"subtype\": \"skill_expansion\", \"skill_name\": \"debug-pipeline\"}')").run();

    runMigrations(db);

    const cols = (db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]).map((r) => r.name);
    assert.ok(cols.includes('invocations'), 'invocations column should exist after #12');
    assert.ok(cols.includes('started_with'), 'started_with column should exist after #12');

    const row = db.prepare("SELECT invocations, started_with FROM sessions WHERE id = 's1'").get() as { invocations: string; started_with: string };
    const inv = JSON.parse(row.invocations);
    assert.deepEqual(inv, [
      { type: 'command', name: '/review' },
      { type: 'skill', name: 'debug-pipeline' },
    ]);
    const sw = JSON.parse(row.started_with);
    assert.deepEqual(sw, { type: 'command', name: '/review' });

    const applied = (db.prepare('SELECT id, name FROM _migrations ORDER BY id').all() as { id: number; name: string }[]);
    assert.ok(applied.find((m) => m.id === 12 && m.name === '012-reconcile-invocations'), 'migration 12 should be recorded');
    db.close();
  });
});
