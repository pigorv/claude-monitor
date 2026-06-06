import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

const TMP = join(tmpdir(), `fts-mig-${Date.now()}`);
const DB_PATH = join(TMP, 'fts.sqlite');

// Minimal pre-12 schema: enough columns for the events_fts backfill + triggers.
function seedPre12(db: Database.Database): void {
  db.exec(`
    CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_type TEXT,
      sequence_num INTEGER,
      input_data TEXT,
      output_data TEXT
    );
  `);
  // Pretend migrations 1..11 already applied so runMigrations only runs #12.
  for (let i = 1; i <= 11; i++) {
    db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(i, `mig-${i}`);
  }
}

/** Enumerate the rowids currently in the FTS index that match a term.
 * NB: `COUNT(*) FROM events_fts` returns the *content* (events) row count on an
 * external-content table, so it must NOT be used to check what is indexed. */
function matchRowids(db: Database.Database, term: string): number[] {
  return (db.prepare('SELECT rowid FROM events_fts WHERE events_fts MATCH ? ORDER BY rowid').all(term) as { rowid: number }[]).map(
    (r) => r.rowid,
  );
}

describe('migration 012-events-fts', () => {
  let db: Database.Database;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    db = new Database(DB_PATH);
  });

  afterEach(() => {
    db?.close();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('creates the FTS table, records the migration, and backfills only message rows', () => {
    seedPre12(db);
    // Pre-existing rows: 1 user msg, 1 assistant msg, 1 tool row (must be excluded).
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','user_message',1,'set up a git worktree please',NULL)").run();
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','assistant_message',2,NULL,'use the git worktree command')").run();
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','tool_call_start',3,'{\"cmd\":\"git worktree add\"}',NULL)").run();

    runMigrations(db);

    const ftsTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events_fts'").get();
    assert.ok(ftsTable, 'events_fts virtual table should exist');

    const applied = db.prepare('SELECT id, name FROM _migrations WHERE id = 12').get() as { id: number; name: string } | undefined;
    assert.deepEqual(applied, { id: 12, name: '012-events-fts' }, 'migration 12 should be recorded');

    // Both message rows indexed, tool row excluded.
    assert.deepEqual(matchRowids(db, '"git worktree"'), [1, 2], 'only the user + assistant rows match');

    // The tool row's distinctive token is not searchable.
    assert.deepEqual(matchRowids(db, 'cmd'), [], 'tool input must not be indexed');

    const integrity = db.prepare("INSERT INTO events_fts(events_fts) VALUES('integrity-check')");
    assert.doesNotThrow(() => integrity.run(), 'FTS integrity-check should pass');
  });

  it('triggers keep the index in sync on insert and delete (incl. a --force-style reimport)', () => {
    seedPre12(db);
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','user_message',1,'original worktree text',NULL)").run();

    runMigrations(db);
    assert.deepEqual(matchRowids(db, 'worktree'), [1], 'backfilled row is searchable');

    // New message insert → indexed; new tool insert → NOT indexed.
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','assistant_message',2,NULL,'a worktree reply')").run();
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','tool_call_end',3,NULL,'worktree tool output')").run();
    assert.deepEqual(matchRowids(db, 'worktree'), [1, 2], 'insert trigger indexes only message rows');

    // Simulate the importer's --force path: delete all events for the session, reinsert.
    db.prepare("DELETE FROM events WHERE session_id = 's1'").run();
    assert.deepEqual(matchRowids(db, 'worktree'), [], 'delete trigger removes rows from the index');

    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','user_message',1,'fresh worktree text',NULL)").run();
    const after = matchRowids(db, 'worktree');
    assert.equal(after.length, 1, 'exactly one row matches after reimport — no stale duplicates');

    const integrity = db.prepare("INSERT INTO events_fts(events_fts) VALUES('integrity-check')");
    assert.doesNotThrow(() => integrity.run(), 'index stays consistent after delete+reinsert');
  });

  it('is idempotent — re-running does not rebuild or double-index', () => {
    seedPre12(db);
    db.prepare("INSERT INTO events (session_id, event_type, sequence_num, input_data, output_data) VALUES ('s1','user_message',1,'idempotent worktree',NULL)").run();

    runMigrations(db);
    runMigrations(db); // second pass must be a no-op (id 12 already in _migrations)

    assert.deepEqual(matchRowids(db, 'worktree'), [1], 'no duplicate index rows after a second run');
  });
});
