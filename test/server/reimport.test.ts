import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import { DEFAULT_CONFIG } from '../../src/shared/constants.js';

describe('Reimport route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reimport-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    getDb(dbPath);
    app = createApp();
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/reimport returns JSON response', async () => {
    const res = await app.request('/api/reimport', { method: 'POST' });
    const body = await res.json();

    // Should have imported/errors fields regardless of outcome
    assert.equal(typeof body.imported, 'number');
    assert.equal(typeof body.errors, 'number');
  });

  it('returns 200 or 500 depending on projects directory existence', async () => {
    const res = await app.request('/api/reimport', { method: 'POST' });

    if (existsSync(DEFAULT_CONFIG.claudeProjectsPath)) {
      // If ~/.claude/projects exists, route should succeed
      assert.equal(res.status, 200);
    } else {
      // If it doesn't exist, route returns 500
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.ok(body.message.includes('Error scanning projects'));
    }
  });

  it('GET /api/reimport returns 404 (only POST allowed)', async () => {
    const res = await app.request('/api/reimport', { method: 'GET' });
    assert.equal(res.status, 404);
  });

  it('response always includes imported and errors counts', async () => {
    const res = await app.request('/api/reimport', { method: 'POST' });
    const body = await res.json();
    assert.ok('imported' in body);
    assert.ok('errors' in body);
    assert.ok(body.imported >= 0);
    assert.ok(body.errors >= 0);
  });

  // ── POST /api/clear ──

  it('POST /api/clear requires confirm=true', async () => {
    const res = await app.request('/api/clear', { method: 'POST' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('confirm=true'));
  });

  it('POST /api/clear rejects confirm=false', async () => {
    const res = await app.request('/api/clear?confirm=false', { method: 'POST' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.includes('confirm=true'));
  });

  it('POST /api/clear deletes all data when confirmed', async () => {
    // Insert some data first
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-clear-test', '/tmp', 'completed', '2026-01-15T10:00:00Z', 100, 50, 0, 0, 0, 0, 0);

    db.prepare(`
      INSERT INTO events (session_id, event_type, event_source, timestamp, sequence_num)
      VALUES (?, ?, ?, ?, ?)
    `).run('sess-clear-test', 'session_start', 'transcript_import', '2026-01-15T10:00:00Z', 1);

    // Verify data exists
    const countBefore = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
    assert.ok(countBefore >= 1);

    // Clear
    const res = await app.request('/api/clear?confirm=true', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cleared, true);
    assert.equal(typeof body.message, 'string');

    // Verify data is gone
    const countAfter = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }).c;
    assert.equal(countAfter, 0);
    const eventCount = (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c;
    assert.equal(eventCount, 0);
  });

  it('GET /api/clear returns 404 (only POST allowed)', async () => {
    const res = await app.request('/api/clear', { method: 'GET' });
    assert.equal(res.status, 404);
  });
});
