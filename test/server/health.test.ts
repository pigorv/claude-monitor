import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import { VERSION } from '../../src/shared/constants.js';

describe('Health route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    getDb(dbPath);
    app = createApp();
  });

  after(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/health returns correct shape', async () => {
    const res = await app.request('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.version, VERSION);
    assert.equal(typeof body.db_size_bytes, 'number');
    assert.equal(typeof body.session_count, 'number');
    assert.equal(typeof body.event_count, 'number');
    assert.equal(body.session_count, 0);
    assert.equal(body.event_count, 0);
  });

  it('GET /api/health returns JSON content type', async () => {
    const res = await app.request('/api/health');
    const contentType = res.headers.get('content-type');
    assert.ok(contentType?.includes('application/json'));
  });

  it('CORS headers are present', async () => {
    const res = await app.request('/api/health', {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  it('CORS rejects non-localhost origins', async () => {
    const res = await app.request('/api/health', {
      headers: { Origin: 'http://evil.com' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('CORS allows 127.0.0.1', async () => {
    const res = await app.request('/api/health', {
      headers: { Origin: 'http://127.0.0.1:4173' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173');
  });

  it('OPTIONS preflight returns CORS headers', async () => {
    const res = await app.request('/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.ok(res.headers.get('access-control-allow-methods')?.includes('GET'));
    assert.ok(res.headers.get('access-control-allow-headers')?.includes('Content-Type'));
  });

  it('returns 404 for unknown routes', async () => {
    const res = await app.request('/api/unknown');
    assert.equal(res.status, 404);
  });

  it('includes node_version field', async () => {
    const res = await app.request('/api/health');
    const body = await res.json();
    assert.equal(typeof body.node_version, 'string');
    assert.ok(body.node_version.length > 0);
  });

  it('includes db_engine and server_port fields', async () => {
    const res = await app.request('/api/health');
    const body = await res.json();
    assert.equal(typeof body.db_engine, 'string');
    assert.equal(typeof body.server_port, 'number');
  });
});
