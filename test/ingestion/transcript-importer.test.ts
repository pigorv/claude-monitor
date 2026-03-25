import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { importTranscript, importTranscripts } from '../../src/ingestion/transcript-importer.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { getSession, sessionExists } from '../../src/db/queries/sessions.js';
import { listEventsBySession, getTokenTimeline } from '../../src/db/queries/events.js';

const TEST_DIR = join(tmpdir(), `claude-monitor-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'test.sqlite');

// ── Sample JSONL content ───────────────────────────────────────────

const SAMPLE_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Hello, please read my file.' },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'uuid-user-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-user-1', cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The user wants me to read a file.' },
        { type: 'text', text: "I'll read that file for you." },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/project/index.ts' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'uuid-asst-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-asst-1', cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: "export const hello = 'world';" }] },
    timestamp: '2026-01-01T00:01:06.000Z', uuid: 'uuid-user-2',
  }),
  JSON.stringify({
    parentUuid: 'uuid-user-2', cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'The file contains a simple export.' }],
      usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:10.000Z', uuid: 'uuid-asst-2',
  }),
].join('\n');

// ── Tests ──────────────────────────────────────────────────────────

describe('importTranscript', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports a transcript and creates session + events', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    const result = await importTranscript(filePath);

    assert.equal(result.sessionId, 'test-session-1');
    assert.equal(result.skipped, false);
    assert.ok(result.eventCount > 0);

    // Verify session in DB
    const session = getSession('test-session-1');
    assert.ok(session);
    assert.equal(session.project_path, '/tmp/project');
    assert.equal(session.project_name, 'project');
    assert.equal(session.model, 'claude-opus-4-6');
    assert.equal(session.status, 'imported');
    assert.equal(session.started_at, '2026-01-01T00:01:00.000Z');
    assert.equal(session.ended_at, '2026-01-01T00:01:10.000Z');
    assert.ok(session.duration_ms! > 0);
    assert.equal(session.total_input_tokens, 2300); // max effective context (input + cache_read + cache_write)
    assert.equal(session.total_output_tokens, 250); // 200 + 50
    assert.equal(session.total_cache_read_tokens, 1300); // 500 + 800
    assert.equal(session.tool_call_count, 1); // Read tool
    assert.equal(session.transcript_path, filePath);
  });

  it('is idempotent — skips already-imported sessions', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    const first = await importTranscript(filePath);
    assert.equal(first.skipped, false);

    const second = await importTranscript(filePath);
    assert.equal(second.skipped, true);
    assert.equal(second.eventCount, 0);
  });

  it('re-imports with force flag', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);
    const second = await importTranscript(filePath, { force: true });
    assert.equal(second.skipped, false);
    assert.ok(second.eventCount > 0);
  });

  it('creates events with correct types', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const { events } = listEventsBySession('test-session-1', { includeThinking: true });
    const types = events.map((e) => e.event_type);

    assert.ok(types.includes('user_message'));
    assert.ok(types.includes('thinking'));
    assert.ok(types.includes('assistant_message'));
    assert.ok(types.includes('tool_call_start'));
    // tool_call_end events are now merged into tool_call_start
  });

  it('stores token data on events', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const { events } = listEventsBySession('test-session-1');
    const assistantEvents = events.filter((e) => e.event_type === 'assistant_message');

    assert.ok(assistantEvents.length > 0);
    const first = assistantEvents[0];
    assert.ok(first.input_tokens !== null);
    assert.ok(first.context_pct !== null);
  });

  it('assigns sequential sequence numbers', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const { events } = listEventsBySession('test-session-1');
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].sequence_num, i);
    }
  });

  it('returns error for empty file', async () => {
    const filePath = join(TEST_DIR, 'empty.jsonl');
    writeFileSync(filePath, '');

    const result = await importTranscript(filePath);
    assert.equal(result.skipped, true);
    assert.ok(result.error?.includes('No messages'));
  });

  it('derives session ID from filename when no sessionId in messages', async () => {
    const jsonl = JSON.stringify({
      parentUuid: null, cwd: '/tmp/proj', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
    });

    const filePath = join(TEST_DIR, 'custom-session-id.jsonl');
    writeFileSync(filePath, jsonl);

    const result = await importTranscript(filePath);
    assert.equal(result.sessionId, 'custom-session-id');
    assert.equal(result.skipped, false);
  });
});

describe('importTranscripts (batch)', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports multiple files', async () => {
    const file1 = join(TEST_DIR, 'sess-a.jsonl');
    const file2 = join(TEST_DIR, 'sess-b.jsonl');

    const jsonl1 = JSON.stringify({
      parentUuid: null, cwd: '/tmp/a', sessionId: 'sess-a', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
    });
    const jsonl2 = JSON.stringify({
      parentUuid: null, cwd: '/tmp/b', sessionId: 'sess-b', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-02T00:00:00.000Z', uuid: 'u2',
    });

    writeFileSync(file1, jsonl1);
    writeFileSync(file2, jsonl2);

    const results = await importTranscripts([file1, file2]);
    assert.equal(results.length, 2);
    assert.ok(sessionExists('sess-a'));
    assert.ok(sessionExists('sess-b'));
  });

  it('handles errors in individual files gracefully', async () => {
    const goodFile = join(TEST_DIR, 'good.jsonl');
    const badFile = join(TEST_DIR, 'nonexistent.jsonl');

    writeFileSync(goodFile, JSON.stringify({
      parentUuid: null, cwd: '/tmp/x', sessionId: 'good-sess', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
    }));

    const results = await importTranscripts([goodFile, badFile]);
    assert.equal(results.length, 2);
    assert.equal(results[0].skipped, false);
    assert.equal(results[1].skipped, true);
    assert.ok(results[1].error);
  });
});

describe('importTranscript with sample fixture', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports the sample-session.jsonl fixture', async () => {
    const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-session.jsonl');

    const result = await importTranscript(fixturePath);
    assert.equal(result.sessionId, 'sess-001');
    assert.equal(result.skipped, false);
    assert.ok(result.eventCount > 0);

    const session = getSession('sess-001');
    assert.ok(session);
    assert.equal(session.model, 'claude-opus-4-6');
    assert.equal(session.project_path, '/tmp/project');
    assert.equal(session.tool_call_count, 3);

    // Token timeline should have data points
    const timeline = getTokenTimeline('sess-001');
    assert.ok(timeline.length > 0);
  });
});
