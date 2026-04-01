import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseLine, parseTranscript } from '../../src/ingestion/jsonl-parser.js';
import { importTranscript } from '../../src/ingestion/transcript-importer.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { getSession, sessionExists } from '../../src/db/queries/sessions.js';
import { listEventsBySession, getTokenTimeline } from '../../src/db/queries/events.js';

// ── JSONL Parser Edge Cases ──────────────────────────────────────────

describe('JSONL parser edge cases', () => {
  it('handles unicode content in messages', () => {
    const line = JSON.stringify({
      type: 'user', uuid: 'u-uni', parentUuid: null,
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's1', cwd: '/tmp',
      message: { role: 'user', content: '你好世界 🌍 こんにちは Привет' },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal(msg.content[0].type, 'text');
    assert.ok((msg.content[0] as { text: string }).text.includes('🌍'));
  });

  it('handles very long message content', () => {
    const longText = 'a'.repeat(100_000);
    const line = JSON.stringify({
      type: 'user', uuid: 'u-long', parentUuid: null,
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's1', cwd: '/tmp',
      message: { role: 'user', content: longText },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal((msg.content[0] as { text: string }).text.length, 100_000);
  });

  it('handles messages with empty content array', () => {
    const line = JSON.stringify({
      type: 'assistant', uuid: 'u-empty-content', parentUuid: 'u1',
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's1', cwd: '/tmp',
      message: { role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 0 } },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal(msg.content.length, 0);
  });

  it('handles messages with multiple tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant', uuid: 'u-multi-tool', parentUuid: 'u1',
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's1', cwd: '/tmp',
      message: {
        model: 'claude-sonnet-4-5', role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/b.ts' } },
          { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'foo' } },
        ],
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal(msg.content.length, 3);
    assert.equal(msg.content.filter(c => c.type === 'tool_use').length, 3);
  });

  it('handles null content in message', () => {
    const line = JSON.stringify({
      type: 'user', uuid: 'u-null', parentUuid: null,
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's1', cwd: '/tmp',
      message: { role: 'user', content: null },
    });
    // Should not crash — either returns null or handles gracefully
    const msg = parseLine(line);
    // Accept either null return or empty content
    if (msg) {
      assert.ok(Array.isArray(msg.content));
    }
  });

  it('handles JSON lines with extra fields gracefully', () => {
    const line = JSON.stringify({
      type: 'user', uuid: 'u-extra', parentUuid: null,
      timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's1', cwd: '/tmp',
      message: { role: 'user', content: 'test' },
      extraField: 'should be ignored',
      anotherOne: { nested: true },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal(msg.type, 'user');
  });
});

describe('parseTranscript edge cases', () => {
  const TEST_DIR = join(tmpdir(), `jsonl-edge-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('handles file with only non-message lines', async () => {
    const content = [
      JSON.stringify({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 100, timestamp: 'x', uuid: 'x' }),
      'not json at all',
      '',
    ].join('\n');

    const filePath = join(TEST_DIR, 'no-messages.jsonl');
    writeFileSync(filePath, content);

    const messages = [];
    for await (const msg of parseTranscript(filePath)) {
      messages.push(msg);
    }
    assert.equal(messages.length, 0);
  });

  it('handles file with blank lines between messages', async () => {
    const content = [
      '',
      JSON.stringify({
        type: 'user', uuid: 'u1', parentUuid: null,
        timestamp: '2026-01-01T00:00:00.000Z', sessionId: 's1', cwd: '/tmp',
        message: { role: 'user', content: 'hi' },
      }),
      '',
      '',
      JSON.stringify({
        type: 'assistant', uuid: 'u2', parentUuid: 'u1',
        timestamp: '2026-01-01T00:01:00.000Z', sessionId: 's1', cwd: '/tmp',
        message: { model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 100, output_tokens: 10 } },
      }),
      '',
    ].join('\n');

    const filePath = join(TEST_DIR, 'blanks.jsonl');
    writeFileSync(filePath, content);

    const messages = [];
    for await (const msg of parseTranscript(filePath)) {
      messages.push(msg);
    }
    assert.equal(messages.length, 2);
  });

  it('parses agent transcript fixture correctly', async () => {
    const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-agent-transcript.jsonl');
    const messages = [];
    for await (const msg of parseTranscript(fixturePath)) {
      messages.push(msg);
    }
    // 4 lines: user, assistant(thinking+tool_use), user(tool_result), assistant(text)
    assert.equal(messages.length, 4);
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[1].type, 'assistant');
    // Second message should have thinking and tool_use
    const thinkingBlocks = messages[1].content.filter(c => c.type === 'thinking');
    assert.equal(thinkingBlocks.length, 1);
  });
});

// ── Transcript Importer Edge Cases ───────────────────────────────────

describe('Transcript importer edge cases', () => {
  const TEST_DIR = join(tmpdir(), `importer-edge-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(join(TEST_DIR, 'test.sqlite'));
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('detects compaction from token drop', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/p', sessionId: 'compact-sess', type: 'user',
        message: { role: 'user', content: 'start' },
        timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
      }),
      JSON.stringify({
        parentUuid: 'u1', cwd: '/tmp/p', sessionId: 'compact-sess', type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5', role: 'assistant',
          content: [{ type: 'text', text: 'working...' }],
          usage: { input_tokens: 150000, output_tokens: 500 },
        },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'a1',
      }),
      JSON.stringify({
        parentUuid: 'a1', cwd: '/tmp/p', sessionId: 'compact-sess', type: 'user',
        message: { role: 'user', content: 'continue' },
        timestamp: '2026-01-01T00:02:00.000Z', uuid: 'u2',
      }),
      // Simulate compaction: input tokens drop sharply from 150000 to 50000
      JSON.stringify({
        parentUuid: 'u2', cwd: '/tmp/p', sessionId: 'compact-sess', type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5', role: 'assistant',
          content: [{ type: 'text', text: 'after compaction' }],
          usage: { input_tokens: 50000, output_tokens: 100 },
        },
        timestamp: '2026-01-01T00:03:00.000Z', uuid: 'a2',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'compact.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('compact-sess');
    assert.ok(session);
    assert.equal(session.compaction_count, 1);
  });

  it('computes risk score and summary for imported session', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/p', sessionId: 'risk-sess', type: 'user',
        message: { role: 'user', content: 'do something complex' },
        timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
      }),
      JSON.stringify({
        parentUuid: 'u1', cwd: '/tmp/p', sessionId: 'risk-sess', type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5', role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
        timestamp: '2026-01-01T00:00:05.000Z', uuid: 'a1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'risk.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('risk-sess');
    assert.ok(session);
    assert.equal(typeof session.risk_score, 'number');
    assert.ok(session.risk_score! >= 0);
    assert.ok(session.risk_score! <= 1);
    assert.ok(session.summary);
    assert.ok(session.summary!.length > 0);
  });

  it('handles transcript with only user messages (no assistant)', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/p', sessionId: 'user-only-sess', type: 'user',
        message: { role: 'user', content: 'hello' },
        timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
      }),
      JSON.stringify({
        parentUuid: 'u1', cwd: '/tmp/p', sessionId: 'user-only-sess', type: 'user',
        message: { role: 'user', content: 'another message' },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u2',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'user-only.jsonl');
    writeFileSync(filePath, jsonl);

    const result = await importTranscript(filePath);
    assert.equal(result.sessionId, 'user-only-sess');
    assert.equal(result.skipped, false);

    const session = getSession('user-only-sess');
    assert.ok(session);
    assert.equal(session.total_input_tokens, 0);
    assert.equal(session.total_output_tokens, 0);
  });

  it('imports the agent transcript fixture', async () => {
    const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-agent-transcript.jsonl');

    const result = await importTranscript(fixturePath);
    assert.ok(result.sessionId);
    assert.equal(result.skipped, false);
    assert.ok(result.eventCount > 0);

    const session = getSession(result.sessionId);
    assert.ok(session);
    assert.equal(session.model, 'claude-sonnet-4-20250514');
    assert.equal(session.tool_call_count, 1); // Read tool
  });

  it('re-imports a transcript with force flag', async () => {
    // Verify re-import works with force flag
    const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-session.jsonl');
    const result = await importTranscript(fixturePath, { force: true });
    assert.equal(result.sessionId, 'sess-001');
    assert.equal(result.skipped, false);
  });
});
