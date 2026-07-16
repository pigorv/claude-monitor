// Versioned DB snapshot generator (committed dev tool, not committed output's source of truth).
//
// Produces genuinely-old on-disk SQLite snapshots to exercise the full
// forward-migration chain (src/db/migrations.ts). The catch: INITIAL_SCHEMA is
// *consolidated* — it already declares the columns migrations 016/017 add, so a
// snapshot built from it would carry those columns and the add-column path would
// no-op on restore. This script holds the ONE frozen artifact — HISTORICAL_V1_SCHEMA,
// equal to INITIAL_SCHEMA with exactly the 8 consolidated 016/017 columns removed —
// so a v1 base genuinely lacks them and the guarded ALTERs really add columns.
//
// Usage:
//   npx tsx scripts/make-db-fixture.mts
//
// Builds test/fixtures/db/{v1,v9,v15}.sqlite. Each snapshot's _migrations table
// ends up holding exactly ids 1..N (N = 1/9/15). The committed BINARY is the
// source of truth; this generator is a reproducibility/bootstrap tool. Migration
// markers use `datetime('now')` DEFAULTs, so regeneration is NOT byte-identical.
//
// WAL note: a bare `new Database(path)` uses the default (delete) journal mode,
// NOT WAL — so each fixture is a single self-contained `.sqlite` file with no
// `-wal`/`-shm` sidecars. Do NOT enable WAL here.

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations, LATEST_MIGRATION_ID } from '../src/db/migrations.js';

// INITIAL_SCHEMA (src/db/schema.ts) with exactly the 8 consolidated columns that
// migrations 016/017 add removed, so the v1 base genuinely lacks them:
//   sessions: total_input_tokens_billed, total_cache_write_5m_tokens,
//             total_cache_write_1h_tokens, cost_estimate_usd
//   agent_relationships: cache_read_total, cache_write_5m_total,
//                        cache_write_1h_total, model
// Every other column, index, and the events table are IDENTICAL to INITIAL_SCHEMA.
const HISTORICAL_V1_SCHEMA = `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    project_name TEXT,
    model TEXT,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cache_read_tokens INTEGER DEFAULT 0,
    total_cache_write_tokens INTEGER DEFAULT 0,
    peak_context_pct REAL,
    compaction_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    subagent_count INTEGER DEFAULT 0,
    summary TEXT,
    end_reason TEXT,
    transcript_path TEXT,
    metadata TEXT
);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT,
    event_type TEXT NOT NULL,
    event_source TEXT NOT NULL DEFAULT 'transcript_import',
    tool_name TEXT,
    timestamp TEXT NOT NULL,
    sequence_num INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    context_pct REAL,
    input_preview TEXT,
    input_data TEXT,
    output_preview TEXT,
    output_data TEXT,
    thinking_summary TEXT,
    thinking_text TEXT,
    duration_ms INTEGER,
    metadata TEXT
);

CREATE TABLE agent_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    child_agent_id TEXT NOT NULL,
    child_transcript_path TEXT,
    prompt_preview TEXT,
    result_preview TEXT,
    prompt_data TEXT,
    result_data TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    input_tokens_total INTEGER,
    output_tokens_total INTEGER,
    tool_call_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running'
);

CREATE INDEX idx_sessions_project ON sessions(project_path);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_events_session ON events(session_id, sequence_num);
CREATE INDEX idx_events_session_time ON events(session_id, timestamp);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_tool ON events(tool_name);
CREATE INDEX idx_events_agent ON events(agent_id);
CREATE INDEX idx_agent_rel_parent ON agent_relationships(parent_session_id);
`;

// Same DDL as the _migrations table in src/db/migrations.ts (runMigrations).
const MIGRATIONS_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
`;

/**
 * Seed synthetic, representative data using ONLY columns present in
 * HISTORICAL_V1_SCHEMA (all original columns, present at every version 1/9/15).
 * The consolidated 016/017 columns are intentionally left at their defaults —
 * matching the "pre-016 import" case: the 017 backfill computes the cost.
 *
 * Fully synthetic: no real paths/emails/machine ids.
 */
function seed(db: Database.Database, version: number): void {
  const insertSession = db.prepare(
    `INSERT INTO sessions
       (id, project_path, started_at, model, status,
        total_cache_read_tokens, total_cache_write_tokens, total_output_tokens)
     VALUES
       (@id, @project_path, @started_at, @model, @status,
        @total_cache_read_tokens, @total_cache_write_tokens, @total_output_tokens)`,
  );

  // s-cmd: carries command + skill_expansion user messages (mig-010 backfill
  // produces non-null invocations/started_with) and known aggregate columns so
  // the mig-017 cost backfill computes ≈ 2.72462.
  insertSession.run({
    id: 's-cmd',
    project_path: '/tmp/proj',
    started_at: '2025-01-01T00:00:00.000Z',
    model: 'claude-sonnet-4-6',
    status: 'imported',
    total_cache_read_tokens: 4191629,
    total_cache_write_tokens: 245135,
    total_output_tokens: 36525,
  });

  // s-plain: a plain session, no command/skill invocation.
  insertSession.run({
    id: 's-plain',
    project_path: '/tmp/proj',
    started_at: '2025-01-02T00:00:00.000Z',
    model: 'claude-sonnet-4-6',
    status: 'imported',
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_output_tokens: 0,
  });

  const insertEvent = db.prepare(
    `INSERT INTO events
       (session_id, event_type, tool_name, timestamp, sequence_num,
        input_data, output_data, metadata)
     VALUES
       (@session_id, @event_type, @tool_name, @timestamp, @sequence_num,
        @input_data, @output_data, @metadata)`,
  );

  // s-cmd events: a /cm-flow command user_message, a skill_expansion user_message,
  // an assistant_message (text so the mig-012 FTS backfill has rows to index),
  // and a tool_use event.
  insertEvent.run({
    session_id: 's-cmd',
    event_type: 'user_message',
    tool_name: null,
    timestamp: '2025-01-01T00:00:01.000Z',
    sequence_num: 1,
    input_data: 'run the flow',
    output_data: null,
    metadata: JSON.stringify({ command: '/cm-flow' }),
  });
  insertEvent.run({
    session_id: 's-cmd',
    event_type: 'user_message',
    tool_name: null,
    timestamp: '2025-01-01T00:00:02.000Z',
    sequence_num: 2,
    input_data: 'expand the skill',
    output_data: null,
    metadata: JSON.stringify({ subtype: 'skill_expansion', skill_name: 'cm-flow' }),
  });
  insertEvent.run({
    session_id: 's-cmd',
    event_type: 'assistant_message',
    tool_name: null,
    timestamp: '2025-01-01T00:00:03.000Z',
    sequence_num: 3,
    input_data: null,
    output_data: 'working on the flow now',
    metadata: null,
  });
  insertEvent.run({
    session_id: 's-cmd',
    event_type: 'tool_use',
    tool_name: 'Read',
    timestamp: '2025-01-01T00:00:04.000Z',
    sequence_num: 4,
    input_data: null,
    output_data: null,
    metadata: null,
  });

  // s-plain events: a plain user turn + an assistant reply.
  insertEvent.run({
    session_id: 's-plain',
    event_type: 'user_message',
    tool_name: null,
    timestamp: '2025-01-02T00:00:01.000Z',
    sequence_num: 1,
    input_data: 'hello there',
    output_data: null,
    metadata: null,
  });
  insertEvent.run({
    session_id: 's-plain',
    event_type: 'assistant_message',
    tool_name: null,
    timestamp: '2025-01-02T00:00:02.000Z',
    sequence_num: 2,
    input_data: null,
    output_data: 'hi, how can I help',
    metadata: null,
  });

  const insertAgentRel = db.prepare(
    `INSERT INTO agent_relationships (parent_session_id, child_agent_id)
     VALUES (@parent_session_id, @child_agent_id)`,
  );

  if (version === 1) {
    // v1 predates mig-005 at generation time (no UNIQUE index yet), so it CAN
    // hold duplicates — seed two so the mig-005 dedup collapses them on restore.
    insertAgentRel.run({ parent_session_id: 's-cmd', child_agent_id: 'agent-1' });
    insertAgentRel.run({ parent_session_id: 's-cmd', child_agent_id: 'agent-1' });
  } else {
    // v9/v15 already have the UNIQUE index — a single row only.
    insertAgentRel.run({ parent_session_id: 's-cmd', child_agent_id: 'agent-1' });
  }
}

/**
 * Build one snapshot at `version` into `destPath`:
 *   1. fresh file DB seeded with the historical (016/017-column-free) v1 schema
 *   2. mark id=1 as applied (the v1 base is applied manually)
 *   3. insert skip-markers for ids version+1 .. LATEST so runMigrations() applies
 *      only migrations 2..version (their guarded ALTERs genuinely add columns)
 *   4. delete markers > version → _migrations now holds exactly 1..version
 *   5. seed synthetic data
 */
function buildSnapshot(version: number, destPath: string): void {
  if (existsSync(destPath)) rmSync(destPath);

  const db = new Database(destPath);
  db.exec(HISTORICAL_V1_SCHEMA);

  db.exec(MIGRATIONS_TABLE_DDL);
  db.prepare("INSERT INTO _migrations (id, name) VALUES (1, '001-initial')").run();

  const skip = db.prepare("INSERT INTO _migrations (id, name) VALUES (?, 'skip')");
  for (let id = version + 1; id <= LATEST_MIGRATION_ID; id++) {
    skip.run(id);
  }

  runMigrations(db); // applies only 2..version on the historical base

  db.prepare('DELETE FROM _migrations WHERE id > ?').run(version);

  seed(db, version);

  // Audit (path, version, row counts).
  const count = (table: string): number =>
    (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
  const ids = (
    db.prepare('SELECT id FROM _migrations ORDER BY id').all() as { id: number }[]
  ).map((r) => r.id);
  console.log(
    `${destPath}  version=${version}  _migrations=[${ids[0]}..${ids[ids.length - 1]}]  ` +
      `sessions=${count('sessions')} events=${count('events')} ` +
      `agent_relationships=${count('agent_relationships')}`,
  );

  db.close();
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'test', 'fixtures', 'db');
  mkdirSync(outDir, { recursive: true });

  buildSnapshot(1, join(outDir, 'v1.sqlite'));
  buildSnapshot(9, join(outDir, 'v9.sqlite'));
  buildSnapshot(15, join(outDir, 'v15.sqlite'));
}

main();
