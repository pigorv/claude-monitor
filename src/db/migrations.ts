import type Database from 'better-sqlite3';
import { INITIAL_SCHEMA } from './schema.js';
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

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
  ).get(table);
  return row !== undefined;
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

function migration012AgentTokenBreakdown(db: Database.Database): void {
  // Some test fixtures pre-create only the sessions table and then run
  // migrations to add later columns; tolerate that by skipping when the
  // target table is absent. Real DBs always have it (created in migration 1).
  if (!tableExists(db, 'agent_relationships')) return;
  if (!tableHasColumn(db, 'agent_relationships', 'initial_context_tokens')) {
    db.exec('ALTER TABLE agent_relationships ADD COLUMN initial_context_tokens INTEGER');
  }
  if (!tableHasColumn(db, 'agent_relationships', 'total_tokens_consumed')) {
    db.exec('ALTER TABLE agent_relationships ADD COLUMN total_tokens_consumed INTEGER');
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
  { id: 12, name: '012-agent-token-breakdown', run: migration012AgentTokenBreakdown },
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
