import type Database from 'better-sqlite3';
import { INITIAL_SCHEMA } from './schema.js';
import {
  recomputeSessionCostFromColumns,
  repriceAllSessions,
  type RepriceAgentRow,
  type RepriceSessionRow,
} from '../analysis/reprice.js';
import * as logger from '../shared/logger.js';

/** Either raw SQL or an imperative function. Function form lets a migration
 * inspect schema state (e.g. via PRAGMA table_info) before mutating it. The
 * discriminated union ensures exactly one of `sql` / `run` is set — `tsc`
 * catches a future migration that defines both or neither. */
type Migration =
  | { id: number; name: string; sql: string }
  | { id: number; name: string; run: (db: Database.Database) => void };

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

const MIGRATION_002_AGENT_EFFICIENCY = `
ALTER TABLE agent_relationships ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE agent_relationships ADD COLUMN result_tokens INTEGER;
ALTER TABLE agent_relationships ADD COLUMN peak_context_tokens INTEGER;
ALTER TABLE agent_relationships ADD COLUMN compression_ratio REAL;
ALTER TABLE agent_relationships ADD COLUMN agent_compaction_count INTEGER DEFAULT 0;
ALTER TABLE agent_relationships ADD COLUMN parent_headroom_at_return INTEGER;
ALTER TABLE agent_relationships ADD COLUMN parent_impact_pct REAL;
ALTER TABLE agent_relationships ADD COLUMN result_classification TEXT;
ALTER TABLE agent_relationships ADD COLUMN execution_mode TEXT;
ALTER TABLE agent_relationships ADD COLUMN files_read_count INTEGER DEFAULT 0;
ALTER TABLE agent_relationships ADD COLUMN files_total_tokens INTEGER DEFAULT 0;
ALTER TABLE agent_relationships ADD COLUMN spawn_timestamp TEXT;
ALTER TABLE agent_relationships ADD COLUMN complete_timestamp TEXT;

ALTER TABLE sessions ADD COLUMN agent_avg_compression REAL;
ALTER TABLE sessions ADD COLUMN agent_total_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN agent_pressure_events INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN agent_compacted_count INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN peak_concurrency INTEGER DEFAULT 0;
`;

const MIGRATION_003_SESSION_LINKS = `
CREATE TABLE IF NOT EXISTS session_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'plan_implementation',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_session_id, target_session_id, link_type)
);
CREATE INDEX IF NOT EXISTS idx_session_links_source ON session_links(source_session_id);
CREATE INDEX IF NOT EXISTS idx_session_links_target ON session_links(target_session_id);
`;

const MIGRATION_004_EVENT_SOURCE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_events_source ON events(session_id, event_source);
`;

const MIGRATION_005_AGENT_REL_UNIQUE = `
DELETE FROM agent_relationships WHERE id NOT IN (
  SELECT MIN(id) FROM agent_relationships GROUP BY parent_session_id, child_agent_id
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_rel_unique ON agent_relationships(parent_session_id, child_agent_id);
`;

const MIGRATION_006_PERF_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_events_session_agent ON events(session_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_session_tool ON events(session_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_events_session_context ON events(session_id, context_pct) WHERE context_pct IS NOT NULL;
`;

const MIGRATION_007_INDEX_CLEANUP = `
-- Drop redundant single-column indexes superseded by composite indexes from migration 006.
-- All queries on events include session_id, so these standalone indexes are never used.
DROP INDEX IF EXISTS idx_events_type;
DROP INDEX IF EXISTS idx_events_tool;
DROP INDEX IF EXISTS idx_events_agent;

-- Covering index for mini timeline queries (adds sequence_num + event_type)
DROP INDEX IF EXISTS idx_events_session_context;
CREATE INDEX idx_events_session_context_v2 ON events(session_id, sequence_num, context_pct, event_type) WHERE context_pct IS NOT NULL;

-- Filtered index for token timeline queries (skip NULL token rows)
CREATE INDEX idx_events_session_tokens ON events(session_id, sequence_num) WHERE input_tokens IS NOT NULL;

-- Filtered index for tool frequency queries (skip NULL tool_name rows)
DROP INDEX IF EXISTS idx_events_session_tool;
CREATE INDEX idx_events_session_tool_v2 ON events(session_id, tool_name) WHERE tool_name IS NOT NULL;
`;

const MIGRATION_008_EVENTS_CACHE_WRITE = `
ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER;
`;

const MIGRATION_009_MODELS_USED = `
ALTER TABLE sessions ADD COLUMN models_used TEXT;
`;

// Backfill SQL for sessions.invocations: dedupe (type, name) pairs and preserve
// first-seen order via MIN(sequence_num). Guarded by `WHERE invocations IS NULL`
// so it's safe to re-run.
const BACKFILL_INVOCATIONS_SQL = `
UPDATE sessions SET invocations = (
  SELECT json_group_array(json_object('type', type, 'name', name))
  FROM (
    SELECT type, name, MIN(sequence_num) AS first_seq
    FROM (
      SELECT
        'command' AS type,
        json_extract(metadata, '$.command') AS name,
        sequence_num
      FROM events
      WHERE session_id = sessions.id
        AND event_type = 'user_message'
        AND json_extract(metadata, '$.command') IS NOT NULL
      UNION ALL
      SELECT
        'skill' AS type,
        json_extract(metadata, '$.skill_name') AS name,
        sequence_num
      FROM events
      WHERE session_id = sessions.id
        AND event_type = 'user_message'
        AND json_extract(metadata, '$.subtype') = 'skill_expansion'
        AND json_extract(metadata, '$.skill_name') IS NOT NULL
    )
    GROUP BY type, name
    ORDER BY first_seq
  )
)
WHERE invocations IS NULL
  AND EXISTS (
    SELECT 1 FROM events
    WHERE session_id = sessions.id
      AND event_type = 'user_message'
      AND (
        json_extract(metadata, '$.command') IS NOT NULL
        OR json_extract(metadata, '$.subtype') = 'skill_expansion'
      )
  );
`;

// Backfill SQL for sessions.started_with: takes the first non-system user
// message and captures whether the session was *kicked off* with a slash
// command or skill. Mirrors deriveStartedWith() in the importer.
const BACKFILL_STARTED_WITH_SQL = `
UPDATE sessions SET started_with = (
  SELECT
    CASE
      WHEN json_extract(metadata, '$.command') IS NOT NULL THEN
        json_object('type', 'command', 'name', json_extract(metadata, '$.command'))
      WHEN json_extract(metadata, '$.subtype') = 'skill_expansion'
       AND json_extract(metadata, '$.skill_name') IS NOT NULL THEN
        json_object('type', 'skill', 'name', json_extract(metadata, '$.skill_name'))
      ELSE NULL
    END
  FROM events
  WHERE session_id = sessions.id
    AND event_type = 'user_message'
    AND (
      json_extract(metadata, '$.subtype') IS NULL
      OR json_extract(metadata, '$.subtype') != 'system_generated'
    )
  ORDER BY sequence_num ASC
  LIMIT 1
)
WHERE started_with IS NULL;
`;

// Single migration for the session-pills feature: adds sessions.invocations
// and sessions.started_with columns and backfills both from events. Uses
// imperative run() rather than raw SQL so the column adds can be guarded
// against pre-existing columns — together with the `WHERE … IS NULL` guards
// in the backfills, the migration is fully idempotent.
function migration010SessionPills(db: Database.Database): void {
  if (!tableHasColumn(db, 'sessions', 'invocations')) {
    db.exec('ALTER TABLE sessions ADD COLUMN invocations TEXT');
  }
  if (!tableHasColumn(db, 'sessions', 'started_with')) {
    db.exec('ALTER TABLE sessions ADD COLUMN started_with TEXT');
  }
  db.exec(BACKFILL_INVOCATIONS_SQL);
  db.exec(BACKFILL_STARTED_WITH_SQL);
}

function migration011DropRiskScore(db: Database.Database): void {
  // One-shot cleanup of stale risk-scoring metadata blobs left over from
  // older imports. Safe because no current reader uses sessions.metadata.
  db.exec("UPDATE sessions SET metadata = NULL WHERE metadata LIKE '%risk_signals%'");
  if (tableHasColumn(db, 'sessions', 'risk_score')) {
    db.exec('ALTER TABLE sessions DROP COLUMN risk_score');
  }
}

function migration014DropEventParentFk(db: Database.Database): void {
  // Drop the dead self-referencing FK `events.parent_event_id`. Every row was
  // always NULL and nothing reads it, but with `PRAGMA foreign_keys = ON` the
  // unindexed FK forced a full events scan on every DELETE — making re-import
  // (delete-then-reinsert) quadratic on large corpora. Guarded for idempotency.
  if (tableHasColumn(db, 'events', 'parent_event_id')) {
    db.exec('ALTER TABLE events DROP COLUMN parent_event_id');
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

/**
 * Full-text search over message content (issue #67). An external-content FTS5
 * table over `events` indexes only user/assistant message text — `input_data`
 * for user turns, `output_data` for assistant turns. Tool events also populate
 * those columns, so the index is filtered by `event_type` (both in the backfill
 * and in the triggers) to keep results low-noise and the index small.
 *
 * Order matters: create the table, backfill existing rows, THEN add the
 * triggers. Backfilling before the triggers exist avoids double-counting rows.
 */
function migration012EventsFts(db: Database.Database): void {
  if (tableExists(db, 'events_fts')) return; // idempotent

  db.exec(`
    CREATE VIRTUAL TABLE events_fts USING fts5(
      input_data, output_data, content='events', content_rowid='id'
    );
  `);

  // Backfill existing message rows so search works without a forced reimport.
  // Filtered to message types — NOT the FTS5 'rebuild' command, which would
  // index every events row (including tool I/O).
  db.exec(`
    INSERT INTO events_fts(rowid, input_data, output_data)
    SELECT id, input_data, output_data FROM events
    WHERE event_type IN ('user_message', 'assistant_message');
  `);

  // Keep the index in sync. `events` is insert/delete-only — there is no
  // UPDATE of input_data/output_data anywhere in the importer (re-import is
  // deleteEventsBySession + bulk insert inside one transaction), so INSERT +
  // DELETE triggers fully cover it.
  //
  // IMPORTANT: the external-content 'delete' command reads old.input_data /
  // old.output_data and they MUST byte-match what was indexed. This holds only
  // because the text columns are never UPDATEd. If a future change adds
  // `UPDATE events SET input_data/output_data = ...`, an AFTER UPDATE trigger
  // becomes mandatory or the FTS index will silently corrupt.
  db.exec(`
    CREATE TRIGGER events_fts_ai AFTER INSERT ON events
    WHEN new.event_type IN ('user_message', 'assistant_message')
    BEGIN
      INSERT INTO events_fts(rowid, input_data, output_data)
      VALUES (new.id, new.input_data, new.output_data);
    END;

    CREATE TRIGGER events_fts_ad AFTER DELETE ON events
    WHEN old.event_type IN ('user_message', 'assistant_message')
    BEGIN
      INSERT INTO events_fts(events_fts, rowid, input_data, output_data)
      VALUES ('delete', old.id, old.input_data, old.output_data);
    END;
  `);
}

// Per-session mtime of the transcript file at its last successful import.
// The watcher seeds its in-memory mtime map from this on startup so that
// sessions created or appended-to while the server was down are (re)imported,
// while unchanged ones are skipped without a full re-parse. Stored as REAL to
// preserve the fractional-millisecond mtimeMs exactly across restarts.
const MIGRATION_013_SESSION_IMPORTED_MTIME = `
ALTER TABLE sessions ADD COLUMN last_imported_mtime REAL;
`;

// Per-subagent mtime of the child transcript file at its last successful import.
// Stored alongside child_transcript_path so a standalone subagent re-import can be
// skipped without re-parsing when the file is unchanged. REAL preserves the
// fractional-millisecond mtimeMs exactly. Guarded with run() (like 014) because
// some partial-schema test fixtures omit the agent_relationships table entirely.
function migration015AgentRelChildMtime(db: Database.Database): void {
  if (!tableExists(db, 'agent_relationships')) return;
  if (!tableHasColumn(db, 'agent_relationships', 'child_imported_mtime')) {
    db.exec('ALTER TABLE agent_relationships ADD COLUMN child_imported_mtime REAL');
  }
}

// Splits cache-write tokens by TTL (5m vs 1h) and records the input tokens
// actually billed. Mirrors the sibling columns' nullability: the `sessions`
// columns default to 0 (like total_cache_write_tokens); the agent_relationships
// columns are nullable (like input_tokens_total). Uses run() with tableHasColumn
// guards for idempotency, and tableExists for agent_relationships because some
// partial-schema test fixtures omit that table entirely (see migration 015).
function migration016CacheWriteSplit(db: Database.Database): void {
  if (!tableHasColumn(db, 'sessions', 'total_input_tokens_billed')) {
    db.exec('ALTER TABLE sessions ADD COLUMN total_input_tokens_billed INTEGER DEFAULT 0');
  }
  if (!tableHasColumn(db, 'sessions', 'total_cache_write_5m_tokens')) {
    db.exec('ALTER TABLE sessions ADD COLUMN total_cache_write_5m_tokens INTEGER DEFAULT 0');
  }
  if (!tableHasColumn(db, 'sessions', 'total_cache_write_1h_tokens')) {
    db.exec('ALTER TABLE sessions ADD COLUMN total_cache_write_1h_tokens INTEGER DEFAULT 0');
  }
  if (tableExists(db, 'agent_relationships')) {
    if (!tableHasColumn(db, 'agent_relationships', 'cache_read_total')) {
      db.exec('ALTER TABLE agent_relationships ADD COLUMN cache_read_total INTEGER');
    }
    if (!tableHasColumn(db, 'agent_relationships', 'cache_write_5m_total')) {
      db.exec('ALTER TABLE agent_relationships ADD COLUMN cache_write_5m_total INTEGER');
    }
    if (!tableHasColumn(db, 'agent_relationships', 'cache_write_1h_total')) {
      db.exec('ALTER TABLE agent_relationships ADD COLUMN cache_write_1h_total INTEGER');
    }
  }
}

// Adds two columns that later tasks populate: agent_relationships.model (each
// sub-agent's model id) and sessions.cost_estimate_usd (precomputed per-session
// cost). Both are nullable with no DEFAULT, mirroring their nullable neighbours
// (input_tokens_total / peak_context_pct). Uses run() with tableHasColumn guards
// for idempotency, and tableExists for agent_relationships because some
// partial-schema test fixtures omit that table entirely (see migrations 015/016).
// After adding the column, backfills it for every existing session so the cost
// is available across history without a re-import (see backfillSessionCost).
function migration017CostAndAgentModel(db: Database.Database): void {
  if (!tableHasColumn(db, 'sessions', 'cost_estimate_usd')) {
    db.exec('ALTER TABLE sessions ADD COLUMN cost_estimate_usd REAL');
  }
  if (tableExists(db, 'agent_relationships')) {
    if (!tableHasColumn(db, 'agent_relationships', 'model')) {
      db.exec('ALTER TABLE agent_relationships ADD COLUMN model TEXT');
    }
  }
  backfillSessionCost(db);
}

// Backfills sessions.cost_estimate_usd for rows left NULL by the column add
// above. The value is otherwise only written at import time, and the importer is
// idempotent — so without this, already-imported sessions never get a cost, and
// many of their transcripts have since been pruned from disk, putting a forced
// reimport out of reach.
//
// Recomputes from the stored aggregate columns through the same sessionCostUsd()
// pricing path as the importer (rates resolved from models.json), so a backfilled
// row matches a freshly-imported one. Three fidelity notes:
//   - sessions.total_output_tokens was inflated at import to include sub-agent
//     output; we subtract that back out (mirroring the agent-merge's
//     `WHERE input_tokens_total IS NOT NULL` sum) so the parent is priced on
//     parent-only output and agent output isn't double-counted.
//   - For the oldest sessions the billed-input and 5m/1h cache-write split
//     columns are 0 (they predate migration 016), so their fresh-input cost is
//     omitted entirely (priced at $0, not merely under-counted) and cache writes
//     price at the default TTL rate. The backfilled figure is a floor for these
//     rows, not an estimate; a forced reimport refines it where the transcript
//     still exists.
//   - agent_relationships.model is NULL for every pre-existing sub-agent (this
//     migration only adds the column), so backfilled sub-agents fall back to the
//     parent model's rates. Per-agent model pricing (e.g. a Haiku sub-agent under
//     an Opus parent) only applies to freshly imported sessions.
// Guarded by `WHERE cost_estimate_usd IS NULL` so it never overwrites an
// import-computed value and is safe to re-run.
function backfillSessionCost(db: Database.Database): void {
  // Needs the full sessions aggregate schema. Real DBs always have it (it's in
  // INITIAL_SCHEMA + migrations 016/017), but the isolated per-migration test
  // fixtures use a minimal sessions table — skip there, matching 015/016/017's
  // defensive guards.
  const required = [
    'cost_estimate_usd',
    'model',
    'total_input_tokens_billed',
    'total_cache_read_tokens',
    'total_cache_write_tokens',
    'total_cache_write_5m_tokens',
    'total_cache_write_1h_tokens',
    'total_output_tokens',
  ];
  if (!required.every((c) => tableHasColumn(db, 'sessions', c))) return;

  const sessions = db
    .prepare(
      `SELECT id, model, started_at, total_input_tokens_billed, total_cache_read_tokens,
              total_cache_write_tokens, total_cache_write_5m_tokens,
              total_cache_write_1h_tokens, total_output_tokens
       FROM sessions
       WHERE cost_estimate_usd IS NULL`,
    )
    .all() as RepriceSessionRow[];

  const agentStmt = tableExists(db, 'agent_relationships')
    ? db.prepare(
        `SELECT model, input_tokens_total, output_tokens_total, cache_read_total,
                cache_write_5m_total, cache_write_1h_total
         FROM agent_relationships
         WHERE parent_session_id = ?`,
      )
    : null;
  const update = db.prepare('UPDATE sessions SET cost_estimate_usd = ? WHERE id = ?');

  for (const s of sessions) {
    const agentRows = (agentStmt?.all(s.id) ?? []) as RepriceAgentRow[];
    const cost = recomputeSessionCostFromColumns(s, agentRows);
    if (cost !== null) update.run(cost, s.id);
  }
}

const MIGRATIONS: Migration[] = [
  { id: 1, name: '001-initial', sql: INITIAL_SCHEMA },
  { id: 2, name: '002-agent-efficiency', sql: MIGRATION_002_AGENT_EFFICIENCY },
  { id: 3, name: '003-session-links', sql: MIGRATION_003_SESSION_LINKS },
  { id: 4, name: '004-event-source-index', sql: MIGRATION_004_EVENT_SOURCE_INDEX },
  { id: 5, name: '005-agent-rel-unique', sql: MIGRATION_005_AGENT_REL_UNIQUE },
  { id: 6, name: '006-perf-indexes', sql: MIGRATION_006_PERF_INDEXES },
  { id: 7, name: '007-index-cleanup', sql: MIGRATION_007_INDEX_CLEANUP },
  { id: 8, name: '008-events-cache-write', sql: MIGRATION_008_EVENTS_CACHE_WRITE },
  { id: 9, name: '009-models-used', sql: MIGRATION_009_MODELS_USED },
  { id: 10, name: '010-session-pills', run: migration010SessionPills },
  { id: 11, name: '011-drop-risk-score', run: migration011DropRiskScore },
  { id: 12, name: '012-events-fts', run: migration012EventsFts },
  { id: 13, name: '013-session-imported-mtime', sql: MIGRATION_013_SESSION_IMPORTED_MTIME },
  { id: 14, name: '014-drop-event-parent-fk', run: migration014DropEventParentFk },
  { id: 15, name: '015-agent-rel-child-mtime', run: migration015AgentRelChildMtime },
  { id: 16, name: '016-cache-write-split', run: migration016CacheWriteSplit },
  { id: 17, name: '017-cost-and-agent-model', run: migration017CostAndAgentModel },
  {
    id: 18,
    name: '018-reprice-with-discounts',
    run: (db) => {
      repriceAllSessions(db);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((row) => (row as { id: number }).id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    logger.info(`Applying migration: ${migration.name}`);
    db.transaction(() => {
      if ('run' in migration) {
        migration.run(db);
      } else {
        db.exec(migration.sql);
      }
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(
        migration.id,
        migration.name,
      );
    })();
    logger.info(`Migration applied: ${migration.name}`);
  }
}
