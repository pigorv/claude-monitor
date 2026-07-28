import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrations.js';
import {
  getDb,
  closeDb,
  insertSession,
  setSessionImportCheckpoint,
  getSessionImportCheckpoint,
} from '../../src/db/index.js';
import type { Session } from '../../src/shared/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    project_path: '/tmp/test',
    project_name: 'test',
    model: 'claude-sonnet-4-20250514',
    models_used: null,
    source: 'startup',
    status: 'completed',
    started_at: '2025-01-01T00:00:00.000Z',
    ended_at: '2025-01-01T01:00:00.000Z',
    duration_ms: 3600000,
    total_input_tokens: 50000,
    total_output_tokens: 10000,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_input_tokens_billed: 0,
    total_cache_write_5m_tokens: 0,
    total_cache_write_1h_tokens: 0,
    peak_context_pct: 10,
    compaction_count: 0,
    tool_call_count: 0,
    subagent_count: 0,
    summary: null,
    end_reason: null,
    transcript_path: '/tmp/t.jsonl',
    metadata: null,
    invocations: null,
    started_with: null,
    ...overrides,
  };
}

function hasColumn(db: Database.Database, column: string): boolean {
  const rows = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

describe('migration 018 — import checkpoint columns', () => {
  it('adds nullable last_imported_size / last_imported_prefix_hash to sessions', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    assert.equal(hasColumn(db, 'last_imported_size'), true);
    assert.equal(hasColumn(db, 'last_imported_prefix_hash'), true);
    db.close();
  });

  it('is idempotent — re-running migration 018 is a no-op', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    // Force migration 018 to re-apply; the guarded column-adds must no-op.
    db.prepare('DELETE FROM _migrations WHERE id = 18').run();
    assert.doesNotThrow(() => runMigrations(db));
    assert.equal(hasColumn(db, 'last_imported_size'), true);
    assert.equal(hasColumn(db, 'last_imported_prefix_hash'), true);
    db.close();
  });
});

describe('import-checkpoint query helpers', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cm-checkpoint-'));
    getDb(join(tmpDir, 'test.sqlite'));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips size, prefix hash and fractional mtime', () => {
    insertSession(makeSession({ id: 'sess-1' }));

    setSessionImportCheckpoint('sess-1', {
      sizeBytes: 4096,
      prefixHash: 'abc123def456',
      mtimeMs: 1706400000123.456,
    });

    const cp = getSessionImportCheckpoint('sess-1');
    assert.ok(cp);
    assert.equal(cp.last_imported_size, 4096);
    assert.equal(cp.last_imported_prefix_hash, 'abc123def456');
    assert.equal(cp.last_imported_mtime, 1706400000123.456);
  });

  it('returns null columns for a session with no checkpoint', () => {
    insertSession(makeSession({ id: 'sess-2' }));
    const cp = getSessionImportCheckpoint('sess-2');
    assert.ok(cp);
    assert.equal(cp.last_imported_size, null);
    assert.equal(cp.last_imported_prefix_hash, null);
    assert.equal(cp.last_imported_mtime, null);
  });

  it('returns undefined for an unknown session', () => {
    assert.equal(getSessionImportCheckpoint('nope'), undefined);
  });
});
