import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';

describe('Export route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'export-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    getDb(dbPath);
    app = createApp();
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/export returns sqlite file', async () => {
    const res = await app.request('/api/export');
    assert.equal(res.status, 200);

    const contentType = res.headers.get('content-type');
    assert.ok(contentType?.includes('application/x-sqlite3'));
  });

  it('sets correct Content-Disposition header', async () => {
    const res = await app.request('/api/export');
    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.ok(disposition.includes('attachment'));
    assert.ok(disposition.includes('claude-monitor-'));
    assert.ok(disposition.includes('.sqlite'));
  });

  it('sets Content-Length header', async () => {
    const res = await app.request('/api/export');
    const length = res.headers.get('content-length');
    assert.ok(length);
    assert.ok(parseInt(length, 10) > 0);
  });

  it('returns valid SQLite data', async () => {
    const res = await app.request('/api/export');
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    // SQLite files start with "SQLite format 3\0"
    const header = String.fromCharCode(...bytes.slice(0, 16));
    assert.ok(header.startsWith('SQLite format 3'));
  });
});
