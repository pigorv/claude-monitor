import type Database from 'better-sqlite3';
import { INITIAL_SCHEMA } from './schema.js';
import * as logger from '../shared/logger.js';

interface Migration {
  id: number;
  name: string;
  sql: string;
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

const MIGRATIONS: Migration[] = [
  { id: 1, name: '001-initial', sql: INITIAL_SCHEMA },
  { id: 2, name: '002-agent-efficiency', sql: MIGRATION_002_AGENT_EFFICIENCY },
  { id: 3, name: '003-session-links', sql: MIGRATION_003_SESSION_LINKS },
  { id: 4, name: '004-event-source-index', sql: MIGRATION_004_EVENT_SOURCE_INDEX },
  { id: 5, name: '005-agent-rel-unique', sql: MIGRATION_005_AGENT_REL_UNIQUE },
  { id: 6, name: '006-perf-indexes', sql: MIGRATION_006_PERF_INDEXES },
  { id: 7, name: '007-index-cleanup', sql: MIGRATION_007_INDEX_CLEANUP },
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
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, name) VALUES (?, ?)').run(
        migration.id,
        migration.name,
      );
    })();
    logger.info(`Migration applied: ${migration.name}`);
  }
}
