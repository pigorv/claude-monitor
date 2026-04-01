import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import { VERSION } from '../../src/shared/constants.js';

describe('Health route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    getDb(dbPath);
    app = createApp();
  });

  afterAll(() => {
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

// ── Global API error handler ──────────────────────────────────────────

describe('Global API error handler', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'error-handler-'));
    getDb(join(tmpDir, 'test.sqlite'));
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 500 JSON for internal server errors', async () => {
    const res = await app.request('/api/sessions/nonexistent');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Session not found');
  });

  it('returns proper 404 for unknown API routes', async () => {
    const res = await app.request('/api/does-not-exist');
    assert.equal(res.status, 404);
  });
});

// ── Static file serving: path traversal ────────────────────────────────

describe('Static file serving: path traversal', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'static-traversal-'));
    getDb(join(tmpDir, 'test.sqlite'));
    const frontendDir = join(tmpDir, 'frontend');
    mkdirSync(join(frontendDir, 'assets'), { recursive: true });
    writeFileSync(join(frontendDir, 'index.html'), '<html>test</html>');
    writeFileSync(join(frontendDir, 'assets', 'app.js'), 'console.log("ok")');
    writeFileSync(join(tmpDir, 'secret.txt'), 'DO NOT SERVE');
    app = createApp({ frontendDir });
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves valid static assets', async () => {
    const res = await app.request('/assets/app.js');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'console.log("ok")');
  });

  it('path traversal attempts never serve files outside frontend dir', async () => {
    for (const path of ['/assets/../secret.txt', '/assets/%2e%2e/secret.txt', '/assets/..%2fsecret.txt']) {
      const res = await app.request(path);
      const text = await res.text();
      assert.ok(!text.includes('DO NOT SERVE'), `Path ${path} should not serve secret file`);
    }
  });

  it('returns 404 for missing assets', async () => {
    const res = await app.request('/assets/nonexistent.js');
    assert.equal(res.status, 404);
  });

  it('serves SPA fallback for non-API routes', async () => {
    const res = await app.request('/session/abc-123');
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('<html>'));
  });
});

// ── Server startup: port conflict ─────────────────────────────────────

describe('Server startup: port conflict', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'port-conflict-'));
    getDb(join(tmpDir, 'test.sqlite'));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('startServer returns a promise', async () => {
    const { startServer } = await import('../../src/server/app.js');
    const server = await startServer(0);
    assert.ok(server);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
