import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

const TMP = join(tmpdir(), `drop-event-parent-fk-${Date.now()}`);
const DB_PATH = join(TMP, 'drop-event-parent-fk.sqlite');

// Pre-12 schema with the dead self-referencing FK that migration 014 removes.
// We stop at migration 11 so runMigrations runs 12 (events_fts) → 13 → 14, i.e.
// 014 drops the column on a DB whose FTS index was built by the *real* migration
// 012 — the exact upgrade path that fresh DBs (built from the post-014 schema.ts)
// never exercise.
function seedPre12WithParentFk(db: Database.Database): void {
  db.exec(`
    CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_event_id INTEGER REFERENCES events(id),
      event_type TEXT,
      sequence_num INTEGER,
      input_data TEXT,
      output_data TEXT
    );
  `);
  for (let i = 1; i <= 11; i++) {
    db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, `mig-${i}`);
  }
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

function matchRowids(db: Database.Database, term: string): number[] {
  return (
    db.prepare('SELECT rowid FROM events_fts WHERE events_fts MATCH ? ORDER BY rowid').all(term) as {
      rowid: number;
    }[]
  ).map((r) => r.rowid);
}

describe('migration 014-drop-event-parent-fk', () => {
  let db: Database.Database;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    db = new Database(DB_PATH);
    // The original quadratic-DELETE bug only manifests with FK enforcement on —
    // and DROP COLUMN of an FK-referenced column must succeed in this mode.
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db?.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('drops parent_event_id and leaves the events_fts index intact', () => {
    seedPre12WithParentFk(db);
    db.prepare("INSERT INTO sessions (id, summary) VALUES ('s1', 'demo')").run();
    // Populate the FK column with a real value (not just NULL) to prove the drop
    // does not choke on a column that actually references another row.
    db.prepare(
      "INSERT INTO events (id, session_id, parent_event_id, event_type, sequence_num, input_data, output_data) VALUES (1,'s1',NULL,'user_message',1,'set up a git worktree',NULL)",
    ).run();
    db.prepare(
      "INSERT INTO events (id, session_id, parent_event_id, event_type, sequence_num, input_data, output_data) VALUES (2,'s1',1,'assistant_message',2,NULL,'using the worktree command')",
    ).run();

    runMigrations(db);

    // Column is gone.
    assert.ok(
      !tableColumns(db, 'events').includes('parent_event_id'),
      'parent_event_id column should be dropped',
    );

    // Migration recorded.
    const applied = db.prepare('SELECT id, name FROM _migrations WHERE id = 14').get() as
      | { id: number; name: string }
      | undefined;
    assert.deepEqual(applied, { id: 14, name: '014-drop-event-parent-fk' }, 'migration 14 should be recorded');

    // The external-content FTS index (built by the real migration 012) survives the
    // DROP COLUMN: both message rows are still searchable by their rowid (= events.id).
    assert.deepEqual(matchRowids(db, 'worktree'), [1, 2], 'both message rows remain indexed after the drop');

    // The AFTER DELETE trigger still keeps the index in sync — it reads
    // old.input_data/old.output_data, which the column drop must not disturb.
    db.prepare("DELETE FROM events WHERE id = 1").run();
    assert.deepEqual(matchRowids(db, 'worktree'), [2], 'delete trigger removes the row from the index post-drop');

    const integrity = db.prepare("INSERT INTO events_fts(events_fts) VALUES('integrity-check')");
    assert.doesNotThrow(() => integrity.run(), 'FTS integrity-check should pass after the drop');
  });

  it('is idempotent when parent_event_id is already absent', () => {
    // Post-014 events table (no parent_event_id), migrations 1–13 already applied.
    db.exec(`
      CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, last_imported_mtime REAL);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        event_type TEXT,
        sequence_num INTEGER,
        input_data TEXT,
        output_data TEXT
      );
      CREATE VIRTUAL TABLE events_fts USING fts5(input_data, output_data, content='events', content_rowid='id');
    `);
    for (let i = 1; i <= 13; i++) {
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, `mig-${i}`);
    }

    // The tableHasColumn guard makes the DROP a no-op — must not throw.
    assert.doesNotThrow(() => runMigrations(db), 'migration 14 should be a no-op when the column is already gone');
    assert.ok(!tableColumns(db, 'events').includes('parent_event_id'));

    const applied = db.prepare('SELECT id FROM _migrations WHERE id = 14').get();
    assert.ok(applied, 'migration 14 should still be recorded');
  });
});
