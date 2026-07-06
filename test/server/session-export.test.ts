import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';

// Minimal zip entry-name reader (mirrors test/export/session-bundle.test.ts).
// We only need the entry names, so no decompression is required.
function zipEntryNames(zip: Buffer): string[] {
  const eocdOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdOffset), 0x06054b50, 'EOCD signature');
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);

  const names: string[] = [];
  let pos = 0;
  while (pos < centralOffset) {
    assert.equal(zip.readUInt32LE(pos), 0x04034b50, 'local header signature');
    const compressedSize = zip.readUInt32LE(pos + 18);
    const nameLen = zip.readUInt16LE(pos + 26);
    const extraLen = zip.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    names.push(zip.toString('utf8', nameStart, nameStart + nameLen));
    pos = nameStart + nameLen + extraLen + compressedSize;
  }
  return names;
}

describe('Session export route (GET /api/sessions/:id/export)', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-export-test-'));
    const db = getDb(join(tmpDir, 'test.sqlite'));

    // A real transcript on disk so buildSessionBundle resolves and zips it.
    transcriptPath = join(tmpDir, 'sess-export.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n',
      'utf8',
    );

    db.prepare(`
      INSERT INTO sessions (
        id, project_path, project_name, model, source, status, started_at,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count,
        subagent_count, transcript_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sess-export', '/home/user/exportproj', 'exportproj', 'claude-sonnet-4-20250514',
      'startup', 'completed', '2026-05-01T00:00:00Z',
      0, 0, 0, 0, 0, 0, 0, transcriptPath,
    );

    // A session whose transcript file does not exist on disk.
    db.prepare(`
      INSERT INTO sessions (
        id, project_path, status, started_at,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count,
        subagent_count, transcript_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sess-gone', '/tmp', 'completed', '2026-05-02T00:00:00Z',
      0, 0, 0, 0, 0, 0, 0, join(tmpDir, 'does-not-exist.jsonl'),
    );

    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 200 with a zip for a valid session', async () => {
    const res = await app.request('/api/sessions/sess-export/export');
    assert.equal(res.status, 200);

    const contentType = res.headers.get('content-type');
    assert.ok(contentType?.includes('application/zip'));

    const disposition = res.headers.get('content-disposition');
    assert.ok(disposition);
    assert.ok(disposition.includes('attachment'));
    assert.ok(disposition.includes('claude-monitor-session-sess-export.zip'));

    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    assert.ok(bytes.length > 0, 'zip body is non-empty');
    // ZIP local-file-header signature: PK\x03\x04.
    assert.equal(bytes[0], 0x50);
    assert.equal(bytes[1], 0x4b);
    assert.equal(bytes[2], 0x03);
    assert.equal(bytes[3], 0x04);

    // Content-Length matches the bytes actually sent.
    const length = res.headers.get('content-length');
    assert.ok(length);
    assert.equal(parseInt(length, 10), bytes.length);
  });

  it('sanitizes by default: bundle carries sanitization-report.json', async () => {
    const res = await app.request('/api/sessions/sess-export/export');
    assert.equal(res.status, 200);

    const names = zipEntryNames(Buffer.from(await res.arrayBuffer()));
    assert.ok(
      names.includes('sanitization-report.json'),
      'default (no query) bundle is sanitized',
    );
    assert.ok(!names.includes('export-manifest.json'));
  });

  it('?sanitize=false returns a raw bundle with export-manifest.json', async () => {
    const res = await app.request('/api/sessions/sess-export/export?sanitize=false');
    assert.equal(res.status, 200);

    const names = zipEntryNames(Buffer.from(await res.arrayBuffer()));
    assert.ok(names.includes('export-manifest.json'), 'raw bundle has manifest');
    assert.ok(
      !names.includes('sanitization-report.json'),
      'raw bundle has no sanitization report',
    );
  });

  it('any value other than false keeps the sanitized default', async () => {
    const res = await app.request('/api/sessions/sess-export/export?sanitize=true');
    assert.equal(res.status, 200);

    const names = zipEntryNames(Buffer.from(await res.arrayBuffer()));
    assert.ok(names.includes('sanitization-report.json'));
    assert.ok(!names.includes('export-manifest.json'));
  });

  it('returns 404 with an actionable message for an unknown session', async () => {
    const res = await app.request('/api/sessions/nonexistent/export');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
    assert.ok(body.error.includes('nonexistent'));
    assert.ok(body.error.includes('no such session'));
  });

  it('returns 404 with an actionable message when the transcript file is gone', async () => {
    const res = await app.request('/api/sessions/sess-gone/export');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(typeof body.error === 'string');
    assert.ok(body.error.includes('no longer exists'));
  });

  it('does not let /api/sessions/:id shadow the /export sub-route', async () => {
    // /api/sessions/sess-export (detail) returns JSON, while
    // /api/sessions/sess-export/export returns a zip — distinct handlers.
    const detail = await app.request('/api/sessions/sess-export');
    assert.equal(detail.status, 200);
    assert.ok(detail.headers.get('content-type')?.includes('application/json'));
  });
});
