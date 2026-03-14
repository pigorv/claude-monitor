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

const MIGRATIONS: Migration[] = [
  { id: 1, name: '001-initial', sql: INITIAL_SCHEMA },
  { id: 2, name: '002-agent-efficiency', sql: MIGRATION_002_AGENT_EFFICIENCY },
  { id: 3, name: '003-session-links', sql: MIGRATION_003_SESSION_LINKS },
  { id: 4, name: '004-event-source-index', sql: MIGRATION_004_EVENT_SOURCE_INDEX },
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
