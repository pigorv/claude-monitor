import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getDb, closeDb, compactDatabase } from '../../src/db/index.js';

const TMP = join(tmpdir(), `compact-db-${Date.now()}`);
const DB_PATH = join(TMP, 'compact.sqlite');

// Number of segment-rows the FTS5 index keeps in its `events_fts_data` shadow
// table. This is what grows across re-imports and what `optimize` collapses.
function ftsSegmentRows(db: ReturnType<typeof getDb>): number {
  return (db.prepare('SELECT count(*) AS n FROM events_fts_data').get() as { n: number }).n;
}

function pageCount(db: ReturnType<typeof getDb>): number {
  return (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
}

/** Insert one indexed message event with distinct text so it adds FTS postings. */
function insertMessage(db: ReturnType<typeof getDb>, seq: number): void {
  db.prepare(
    `INSERT INTO events (session_id, event_type, timestamp, sequence_num, input_data, output_data)
     VALUES ('s', 'user_message', '2026-01-01T00:00:00.000Z', ?, ?, ?)`,
  ).run(seq, `question number ${seq} about indexing`, `answer number ${seq} about segments`);
}

/** Simulate one force re-import: delete every event (fires FTS delete-markers)
 * then reinsert under fresh autoincrement ids (new FTS segments). */
function reimportChurn(db: ReturnType<typeof getDb>, rows: number): void {
  db.exec('DELETE FROM events');
  const insert = db.transaction((n: number) => {
    for (let i = 0; i < n; i++) insertMessage(db, i);
  });
  insert(rows);
}

describe('compactDatabase (re-import bloat reclamation)', () => {
  let db: ReturnType<typeof getDb>;

  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
    db = getDb(DB_PATH);
    db.prepare(
      `INSERT INTO sessions (id, project_path, started_at) VALUES ('s', '/tmp/p', '2026-01-01T00:00:00.000Z')`,
    ).run();
  });

  afterEach(() => {
    closeDb();
    rmSync(TMP, { recursive: true, force: true });
  });

  it('VACUUM alone leaves the FTS index bloated; optimize+VACUUM collapses it', () => {
    const ROWS = 60;

    // Churn many re-imports so FTS5 accumulates un-merged segments.
    for (let r = 0; r < 12; r++) reimportChurn(db, ROWS);

    const segmentsAfterChurn = ftsSegmentRows(db);

    // VACUUM repacks pages but copies FTS segments verbatim — it does NOT merge them.
    db.exec('VACUUM');
    assert.equal(
      ftsSegmentRows(db),
      segmentsAfterChurn,
      'VACUUM must not change the FTS5 segment count (it does not consolidate the index)',
    );

    // optimize merges every segment into one; the index collapses.
    compactDatabase(db);
    const segmentsAfterCompact = ftsSegmentRows(db);
    assert.ok(
      segmentsAfterCompact < segmentsAfterChurn,
      `optimize must shrink the FTS index: ${segmentsAfterCompact} should be < ${segmentsAfterChurn}`,
    );
  });

  it('repeated re-import + compaction reaches a stable floor (no unbounded growth)', () => {
    const ROWS = 60;

    reimportChurn(db, ROWS);
    compactDatabase(db);
    const floorSegments = ftsSegmentRows(db);
    const floorPages = pageCount(db);

    // Many more re-imports, each followed by compaction, must not grow past the floor.
    for (let r = 0; r < 10; r++) {
      reimportChurn(db, ROWS);
      compactDatabase(db);
      assert.equal(
        ftsSegmentRows(db),
        floorSegments,
        'compacted FTS segment count must stay at the floor across re-imports',
      );
      assert.ok(
        pageCount(db) <= floorPages,
        `compacted page count must not exceed the floor (${pageCount(db)} <= ${floorPages})`,
      );
    }
  });
});
