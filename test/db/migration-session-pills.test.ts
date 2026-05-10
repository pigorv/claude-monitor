import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

const TMP = join(tmpdir(), `drift-${Date.now()}`);
const DB_PATH = join(TMP, 'drift.sqlite');

describe('migration 010-session-pills', () => {
  let db: Database.Database;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    db = new Database(DB_PATH);
  });

  afterEach(() => {
    db?.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('adds invocations + started_with columns and backfills from events', () => {
    db.exec(`
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, metadata TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, event_type TEXT, sequence_num INTEGER, metadata TEXT);
    `);
    for (let i = 1; i <= 9; i++) {
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, `mig-${i}`);
    }
    db.prepare("INSERT INTO sessions (id, summary, metadata) VALUES ('s1', 'demo', NULL)").run();
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, metadata) VALUES ('s1', 'user_message', 1, '{\"command\": \"/review\"}')").run();
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, metadata) VALUES ('s1', 'user_message', 2, '{\"subtype\": \"skill_expansion\", \"skill_name\": \"debug-pipeline\"}')").run();

    runMigrations(db);

    const cols = (db.prepare("SELECT name FROM pragma_table_info('sessions')").all() as { name: string }[]).map((r) => r.name);
    assert.ok(cols.includes('invocations'), 'invocations column should be added');
    assert.ok(cols.includes('started_with'), 'started_with column should be added');

    const row = db.prepare("SELECT invocations, started_with FROM sessions WHERE id = 's1'").get() as { invocations: string; started_with: string };
    assert.deepEqual(JSON.parse(row.invocations), [
      { type: 'command', name: '/review' },
      { type: 'skill', name: 'debug-pipeline' },
    ]);
    assert.deepEqual(JSON.parse(row.started_with), { type: 'command', name: '/review' });

    const applied = (db.prepare('SELECT id, name FROM _migrations ORDER BY id').all() as { id: number; name: string }[]);
    assert.ok(applied.find((m) => m.id === 10 && m.name === '010-session-pills'), 'migration 10 should be recorded');
  });

  it('is idempotent when columns already exist (re-running on a partially-set-up DB is a no-op)', () => {
    db.exec(`
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        summary TEXT,
        metadata TEXT,
        invocations TEXT,
        started_with TEXT
      );
      CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, event_type TEXT, sequence_num INTEGER, metadata TEXT);
    `);
    for (let i = 1; i <= 9; i++) {
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, `mig-${i}`);
    }
    // Pre-populated row — migration must NOT clobber the existing values.
    const existing = JSON.stringify([{ type: 'command', name: '/preserve' }]);
    db.prepare("INSERT INTO sessions (id, summary, invocations, started_with) VALUES ('s1', 'demo', ?, ?)").run(
      existing,
      JSON.stringify({ type: 'command', name: '/preserve' }),
    );
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, metadata) VALUES ('s1', 'user_message', 1, '{\"command\": \"/different\"}')").run();

    runMigrations(db);

    const row = db.prepare("SELECT invocations, started_with FROM sessions WHERE id = 's1'").get() as { invocations: string; started_with: string };
    assert.equal(row.invocations, existing, 'pre-populated invocations should be preserved');
    assert.deepEqual(JSON.parse(row.started_with), { type: 'command', name: '/preserve' });
  });
});
