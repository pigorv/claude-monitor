import { describe, it, beforeAll, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import * as importer from '../../src/ingestion/transcript-importer.js';

describe('Reimport route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  // Poll the status endpoint until the background run reports done.
  // Every test that starts a run MUST await this before returning, otherwise
  // the module-level status leaks into the next test (spurious 409s) and a run
  // in flight during afterAll's closeDb() would error.
  async function waitForDone(timeoutMs = 30000): Promise<any> {
    const start = Date.now();
    for (;;) {
      const res = await app.request('/api/reimport/status');
      const body = await res.json();
      if (body.done) return body;
      if (Date.now() - start > timeoutMs) throw new Error('reimport did not finish in time');
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reimport-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    getDb(dbPath);
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('POST /api/reimport returns 202 { started: true }', async () => {
    const res = await app.request('/api/reimport', { method: 'POST' });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.started, true);

    await waitForDone();
  });

  it('GET /api/reimport returns 404 (only POST allowed)', async () => {
    const res = await app.request('/api/reimport', { method: 'GET' });
    assert.equal(res.status, 404);
  });

  it('runs in the background: 202 start, concurrent 409, other endpoints respond, final status shape', async () => {
    // Start a run.
    const first = await app.request('/api/reimport', { method: 'POST' });
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    assert.equal(firstBody.started, true);

    // A second POST issued in the same tick (no await advancing the runner past
    // its initial setImmediate) still sees running === true, so it must 409.
    const second = await app.request('/api/reimport', { method: 'POST' });
    assert.equal(second.status, 409);

    // Other endpoints still respond while the run is in flight — the POST
    // handler did not block. (If the corpus is tiny the run may already be
    // done; the point is that health resolves, not timing.)
    const health = await app.request('/api/health');
    assert.equal(health.status, 200);

    // After completion the public status has the five required keys + phase,
    // processed === total, counts >= 0, done: true.
    const status = await waitForDone();
    for (const key of ['total', 'processed', 'imported', 'errors', 'done']) {
      assert.ok(key in status, `status missing key: ${key}`);
    }
    assert.ok('phase' in status);
    assert.equal(status.done, true);
    assert.equal(status.phase, 'done');
    assert.equal(status.processed, status.total);
    assert.equal(typeof status.imported, 'number');
    assert.equal(typeof status.errors, 'number');
    assert.ok(status.imported >= 0);
    assert.ok(status.errors >= 0);
  });

  it('error path: failed run ends done/!running with error set, and a new run can start', async () => {
    // Force importTranscripts to throw so runReimport hits its catch branch.
    const spy = vi.spyOn(importer, 'importTranscripts').mockRejectedValueOnce(new Error('boom'));

    const res = await app.request('/api/reimport', { method: 'POST' });
    assert.equal(res.status, 202);

    const status = await waitForDone();
    assert.equal(status.done, true);
    assert.equal(status.running, false);
    assert.equal(typeof status.error, 'string');
    assert.ok(status.error.length > 0);
    assert.ok(status.error.includes('boom'), `error should mention thrown cause: ${status.error}`);

    spy.mockRestore();

    // running was cleared, so a fresh run can start.
    const again = await app.request('/api/reimport', { method: 'POST' });
    assert.equal(again.status, 202);
    const againBody = await again.json();
    assert.equal(againBody.started, true);

    await waitForDone();
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
