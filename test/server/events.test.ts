import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';

describe('Events route', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'events-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    const db = getDb(dbPath);

    // Insert a test session
    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-1', '/tmp/proj', 'completed', '2026-01-15T10:00:00Z', 5000, 3000, 1000, 500, 1, 5, 0);

    // Insert events
    const insertEvent = db.prepare(`
      INSERT INTO events (
        session_id, event_type, event_source, tool_name, timestamp, sequence_num,
        input_tokens, output_tokens, cache_read_tokens, context_pct, duration_ms,
        thinking_text, thinking_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertEvent.run('sess-1', 'tool_call_start', 'transcript_import', 'Read', '2026-01-15T10:01:00Z', 1, 100, 50, 10, 0.1, 200, null, null);
    insertEvent.run('sess-1', 'tool_call_end', 'transcript_import', 'Read', '2026-01-15T10:01:01Z', 2, 150, 80, 15, 0.15, 250, null, null);
    insertEvent.run('sess-1', 'thinking', 'transcript_import', null, '2026-01-15T10:02:00Z', 3, 200, 100, 20, 0.2, null, 'Full thinking text here about the code', 'Full thinking text here');
    insertEvent.run('sess-1', 'tool_call_start', 'transcript_import', 'Write', '2026-01-15T10:03:00Z', 4, 300, 150, 30, 0.3, 300, null, null);
    insertEvent.run('sess-1', 'compaction', 'transcript_import', null, '2026-01-15T10:05:00Z', 5, 500, 200, 50, 0.5, null, null, null);

    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns events for a session', async () => {
    const res = await app.request('/api/sessions/sess-1/events');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 5);
    assert.equal(body.events.length, 5);
    assert.equal(body.limit, 100);
    assert.equal(body.offset, 0);
  });

  it('returns 404 for unknown session', async () => {
    const res = await app.request('/api/sessions/nonexistent/events');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Session not found');
  });

  it('filters by event_type', async () => {
    const res = await app.request('/api/sessions/sess-1/events?event_type=thinking');
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.events[0].event_type, 'thinking');
  });

  it('filters by tool_name', async () => {
    const res = await app.request('/api/sessions/sess-1/events?tool_name=Read');
    const body = await res.json();
    assert.equal(body.total, 2);
    for (const e of body.events) {
      assert.equal(e.tool_name, 'Read');
    }
  });

  it('paginates with limit and offset', async () => {
    const res = await app.request('/api/sessions/sess-1/events?limit=2&offset=0');
    const body = await res.json();
    assert.equal(body.events.length, 2);
    assert.equal(body.total, 5);
    assert.equal(body.limit, 2);
    assert.equal(body.offset, 0);

    const res2 = await app.request('/api/sessions/sess-1/events?limit=2&offset=2');
    const body2 = await res2.json();
    assert.equal(body2.events.length, 2);
    assert.notEqual(body2.events[0].id, body.events[0].id);
  });

  it('excludes thinking_text by default', async () => {
    const res = await app.request('/api/sessions/sess-1/events?event_type=thinking');
    const body = await res.json();
    assert.equal(body.events[0].thinking_text, undefined);
    assert.equal(body.events[0].thinking_summary, 'Full thinking text here');
  });

  it('includes thinking_text when requested', async () => {
    const res = await app.request('/api/sessions/sess-1/events?event_type=thinking&include_thinking=true');
    const body = await res.json();
    assert.equal(body.events[0].thinking_text, 'Full thinking text here about the code');
  });

  it('returns events in sequence order', async () => {
    const res = await app.request('/api/sessions/sess-1/events');
    const body = await res.json();
    for (let i = 1; i < body.events.length; i++) {
      assert.ok(body.events[i].sequence_num >= body.events[i - 1].sequence_num);
    }
  });
});
