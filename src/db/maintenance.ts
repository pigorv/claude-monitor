import type Database from 'better-sqlite3';

/**
 * Reclaim the disk space left behind by re-import churn.
 *
 * A force re-import deletes every message row and reinserts it under a fresh
 * autoincrement id. That leaves two kinds of bloat:
 *
 *  1. Free pages in the main database from the deleted rows.
 *  2. Stale segments in the FTS5 index. FTS5 keeps its inverted index as a set
 *     of b-tree "segments" in the `events_fts_data` shadow table; each
 *     delete+reinsert adds new segments and delete-markers, and FTS5's
 *     automerge only partially consolidates them.
 *
 * `VACUUM` alone fixes (1) but NOT (2) — it repacks pages but copies the FTS5
 * segments verbatim, so the index (and the file) keeps growing across
 * re-imports. The FTS5 `'optimize'` command merges all segments into one,
 * collapsing the index to its minimum; running it before `VACUUM` gives a
 * stable on-disk size regardless of how many times the corpus is re-imported.
 *
 * Both statements are synchronous (better-sqlite3) and run in autocommit —
 * `VACUUM` in particular cannot run inside a transaction.
 */
export function compactDatabase(db: Database.Database): void {
  const hasFts = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events_fts'")
    .get();
  if (hasFts) {
    db.exec("INSERT INTO events_fts(events_fts) VALUES('optimize')");
  }
  db.exec('VACUUM');
}
