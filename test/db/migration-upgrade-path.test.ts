import { describe, it, afterEach, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';

/**
 * Forward upgrade-path test (T1.2). Restores genuinely-old committed SQLite
 * snapshots (`test/fixtures/db/{v1,v9,v15}.sqlite`, whose `_migrations` tables
 * hold exactly ids 1..N) and drives them through the public runMigrations()
 * entrypoint, asserting:
 *   - no data loss (every seeded sessions/events/agent_relationships row survives
 *     with values intact),
 *   - the final schema (each table's column set + the full `_migrations` id set)
 *     matches a freshly-migrated in-memory reference DB,
 *   - backfills produce correct values (invocations/started_with from mig 010 on
 *     the pre-mig-010 fixtures; cost_estimate_usd from mig 017 on all three; the
 *     duplicate agent_relationships rows in v1 deduped to one by mig 005),
 *   - re-running runMigrations() is a no-op.
 */

/** Sorted column names of a table via PRAGMA table_info. */
function columnSet(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((r) => r.name)
    .sort();
}

/** Sorted id set of the `_migrations` marker table. */
function migrationIds(db: Database.Database): number[] {
  return (db.prepare('SELECT id FROM _migrations').all() as { id: number }[])
    .map((r) => r.id)
    .sort((a, b) => a - b);
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// Build the single shared reference: a freshly-migrated in-memory DB whose
// schema is the "expected final state" every restored fixture must match.
const ref = new Database(':memory:');
runMigrations(ref);
const REF_SESSIONS_COLS = columnSet(ref, 'sessions');
const REF_EVENTS_COLS = columnSet(ref, 'events');
const REF_AGENT_REL_COLS = columnSet(ref, 'agent_relationships');
const REF_MIGRATION_IDS = migrationIds(ref);

// The 8 columns consolidated by migrations 016/017 — added past every captured
// version (all < 16), so absent from all three snapshots pre-migration.
const CONSOLIDATED_SESSION_COLS = [
  'total_input_tokens_billed',
  'total_cache_write_5m_tokens',
  'total_cache_write_1h_tokens',
  'cost_estimate_usd',
];
const CONSOLIDATED_AGENT_REL_COLS = [
  'cache_read_total',
  'cache_write_5m_total',
  'cache_write_1h_total',
  'model',
];
// sessions.invocations / started_with — added by migration 010, so present
// pre-migration only in fixtures captured at v10 or later (of our set, just v15).
const SESSION_PILLS_COLS = ['invocations', 'started_with'];

interface Case {
  name: string;
  version: number;
  dupAgents: boolean; // v1 holds 2 duplicate agent_relationships rows (deduped by mig 005)
  backfillsInvocations: boolean; // mig 010 fires on restore only for pre-mig-010 fixtures
}

const CASES: Case[] = [
  { name: 'v1', version: 1, dupAgents: true, backfillsInvocations: true },
  { name: 'v9', version: 9, dupAgents: false, backfillsInvocations: true },
  { name: 'v15', version: 15, dupAgents: false, backfillsInvocations: false },
];

describe('forward migration upgrade-path over versioned fixtures', () => {
  let db: Database.Database | undefined;
  let tmpPath: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (tmpPath && existsSync(tmpPath)) unlinkSync(tmpPath);
    tmpPath = undefined;
  });

  for (const c of CASES) {
    it(`upgrades ${c.name} (mig ${c.version} → current) with no data loss and correct backfills`, () => {
      // Copy the committed fixture to a process-scoped temp path — never mutate
      // the fixture in place. The pid keeps two concurrent vitest invocations on
      // one machine (CI + local watch) off the same file. Unlink any stale copy
      // from a prior run first.
      const fixturePath = fileURLToPath(
        new URL(`../fixtures/db/${c.name}.sqlite`, import.meta.url),
      );
      tmpPath = join(tmpdir(), `cm-migration-upgrade-${c.name}-${process.pid}.sqlite`);
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
      copyFileSync(fixturePath, tmpPath);

      db = new Database(tmpPath);

      // ---- Pre-state: prove each fixture is genuinely its claimed old version,
      // not just that MAX(id) lines up. The `_migrations` set must be exactly
      // 1..version (no gaps, no strays), and the schema must match what that
      // version actually looked like. Without this, a regeneration bug in a
      // committed binary is invisible: the post-migration schema is normalized
      // against `ref`, which papers over a wrong starting shape. This check runs
      // for every case, not just v1. ----
      assert.deepEqual(
        migrationIds(db),
        Array.from({ length: c.version }, (_, i) => i + 1),
        `${c.name}: pre-state _migrations holds exactly 1..${c.version}`,
      );

      const preSessCols = columnSet(db, 'sessions');
      const preArCols = columnSet(db, 'agent_relationships');
      for (const col of CONSOLIDATED_SESSION_COLS) {
        assert.ok(
          !preSessCols.includes(col),
          `${c.name}: sessions should lack ${col} pre-migration`,
        );
      }
      for (const col of CONSOLIDATED_AGENT_REL_COLS) {
        assert.ok(
          !preArCols.includes(col),
          `${c.name}: agent_relationships should lack ${col} pre-migration`,
        );
      }

      // invocations/started_with are added by mig 010, so they exist pre-migration
      // iff the fixture was captured at v10 or later — present in v15, absent in v1/v9.
      const hasSessionPillsCols = c.version >= 10;
      for (const col of SESSION_PILLS_COLS) {
        assert.equal(
          preSessCols.includes(col),
          hasSessionPillsCols,
          `${c.name}: sessions ${hasSessionPillsCols ? 'should have' : 'should lack'} ${col} pre-migration`,
        );
      }

      // Capture pre-migration row counts and seeded key values.
      const sessionsBefore = count(db, 'sessions');
      const eventsBefore = count(db, 'events');
      const agentRelBefore = count(db, 'agent_relationships');
      assert.equal(sessionsBefore, 2, `${c.name}: expected 2 seeded sessions`);
      assert.equal(eventsBefore, 6, `${c.name}: expected 6 seeded events`);
      assert.equal(agentRelBefore, c.dupAgents ? 2 : 1, `${c.name}: seeded agent_rel count`);

      const outputBefore = (
        db
          .prepare("SELECT total_output_tokens AS t FROM sessions WHERE id = 's-cmd'")
          .get() as { t: number }
      ).t;
      assert.equal(outputBefore, 36525);

      // ---- First migration pass ----
      runMigrations(db);

      // ---- No data loss (Behavior 3) ----
      assert.equal(count(db, 'sessions'), 2, `${c.name}: sessions preserved`);
      assert.equal(count(db, 'events'), 6, `${c.name}: events preserved`);
      // v1's duplicate agent_relationships deduped to 1 by mig 005; v9/v15 preserved.
      assert.equal(
        count(db, 'agent_relationships'),
        1,
        `${c.name}: agent_relationships (deduped for v1, preserved for v9/v15)`,
      );

      // Seeded values intact.
      const sCmd = db
        .prepare(
          `SELECT model, status, total_cache_read_tokens, total_cache_write_tokens,
                  total_output_tokens, project_path, started_at,
                  invocations, started_with, cost_estimate_usd
           FROM sessions WHERE id = 's-cmd'`,
        )
        .get() as {
        model: string;
        status: string;
        total_cache_read_tokens: number;
        total_cache_write_tokens: number;
        total_output_tokens: number;
        project_path: string;
        started_at: string;
        invocations: string | null;
        started_with: string | null;
        cost_estimate_usd: number | null;
      };
      assert.equal(sCmd.model, 'claude-sonnet-4-6');
      assert.equal(sCmd.status, 'imported');
      assert.equal(sCmd.total_cache_read_tokens, 4191629);
      assert.equal(sCmd.total_cache_write_tokens, 245135);
      assert.equal(sCmd.total_output_tokens, 36525);
      assert.equal(sCmd.project_path, '/tmp/proj');
      assert.equal(sCmd.started_at, '2025-01-01T00:00:00.000Z');

      // Seeded event metadata still present (the command + skill_expansion rows).
      const cmdMeta = db
        .prepare(
          `SELECT metadata FROM events
           WHERE session_id = 's-cmd' AND json_extract(metadata, '$.command') = '/cm-flow'`,
        )
        .get() as { metadata: string } | undefined;
      assert.ok(cmdMeta, `${c.name}: command event metadata survived`);
      const skillMeta = db
        .prepare(
          `SELECT metadata FROM events
           WHERE session_id = 's-cmd'
             AND json_extract(metadata, '$.subtype') = 'skill_expansion'
             AND json_extract(metadata, '$.skill_name') = 'cm-flow'`,
        )
        .get() as { metadata: string } | undefined;
      assert.ok(skillMeta, `${c.name}: skill_expansion event metadata survived`);

      // ---- Final schema equals the reference (Behavior 4) ----
      assert.deepEqual(columnSet(db, 'sessions'), REF_SESSIONS_COLS, `${c.name}: sessions cols`);
      assert.deepEqual(columnSet(db, 'events'), REF_EVENTS_COLS, `${c.name}: events cols`);
      assert.deepEqual(
        columnSet(db, 'agent_relationships'),
        REF_AGENT_REL_COLS,
        `${c.name}: agent_relationships cols`,
      );
      assert.deepEqual(migrationIds(db), REF_MIGRATION_IDS, `${c.name}: _migrations id set`);

      // ---- Backfills (Behavior 5) ----
      // mig 010 backfill fires on restore only for pre-mig-010 fixtures (v1, v9).
      if (c.backfillsInvocations) {
        assert.ok(sCmd.invocations != null, `${c.name}: invocations backfilled (mig 010)`);
        assert.ok(sCmd.started_with != null, `${c.name}: started_with backfilled (mig 010)`);
      } else {
        // v15's marker for mig 010 is already present, so it does not re-run.
        assert.equal(sCmd.invocations, null, `${c.name}: invocations not re-backfilled`);
        assert.equal(sCmd.started_with, null, `${c.name}: started_with not re-backfilled`);
      }
      // mig 017 cost backfill fires on restore for all three (all pre-mig-017).
      assert.ok(sCmd.cost_estimate_usd != null, `${c.name}: cost_estimate_usd backfilled`);
      assert.ok(
        Math.abs((sCmd.cost_estimate_usd as number) - 2.72462) < 1e-5,
        `${c.name}: expected cost ~2.72462, got ${sCmd.cost_estimate_usd}`,
      );

      // ---- Idempotency: second pass is a no-op (Behavior 6) ----
      const sessionsAfter = count(db, 'sessions');
      const eventsAfter = count(db, 'events');
      const agentRelAfter = count(db, 'agent_relationships');
      const sessionsColsAfter = columnSet(db, 'sessions');
      const eventsColsAfter = columnSet(db, 'events');
      const agentRelColsAfter = columnSet(db, 'agent_relationships');
      const idsAfter = migrationIds(db);

      assert.doesNotThrow(() => runMigrations(db!), `${c.name}: second runMigrations throws`);

      assert.equal(count(db, 'sessions'), sessionsAfter, `${c.name}: sessions count unchanged`);
      assert.equal(count(db, 'events'), eventsAfter, `${c.name}: events count unchanged`);
      assert.equal(
        count(db, 'agent_relationships'),
        agentRelAfter,
        `${c.name}: agent_relationships count unchanged`,
      );
      assert.deepEqual(columnSet(db, 'sessions'), sessionsColsAfter, `${c.name}: sessions cols stable`);
      assert.deepEqual(columnSet(db, 'events'), eventsColsAfter, `${c.name}: events cols stable`);
      assert.deepEqual(
        columnSet(db, 'agent_relationships'),
        agentRelColsAfter,
        `${c.name}: agent_relationships cols stable`,
      );
      assert.deepEqual(migrationIds(db), idsAfter, `${c.name}: _migrations id set stable`);
      assert.deepEqual(migrationIds(db), REF_MIGRATION_IDS, `${c.name}: still full id set`);
    });
  }

  afterAll(() => {
    ref.close();
  });
});
