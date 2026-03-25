import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseLine, parseTranscript } from '../../src/ingestion/jsonl-parser.js';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'fixtures', 'sample-session.jsonl');

describe('parseLine', () => {
  it('should return null for empty lines', () => {
    assert.equal(parseLine(''), null);
    assert.equal(parseLine('   '), null);
  });

  it('should return null for malformed JSON', () => {
    assert.equal(parseLine('this is not json {{{'), null);
  });

  it('should skip file-history-snapshot lines', () => {
    const line = JSON.stringify({
      type: 'file-history-snapshot',
      messageId: 'msg-1',
      snapshot: {},
    });
    assert.equal(parseLine(line), null);
  });

  it('should skip progress lines', () => {
    const line = JSON.stringify({
      type: 'progress',
      data: { type: 'hook_progress' },
      timestamp: '2026-01-01T00:00:00.000Z',
      uuid: 'uuid-1',
    });
    assert.equal(parseLine(line), null);
  });

  it('should skip system lines with turn_duration subtype', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 5000,
      timestamp: '2026-01-01T00:00:00.000Z',
      uuid: 'uuid-1',
    });
    assert.equal(parseLine(line), null);
  });

  it('should parse a user message with string content', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-1',
      parentUuid: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'sess-1',
      cwd: '/tmp',
      message: { role: 'user', content: 'Hello world' },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal(msg.type, 'user');
    assert.equal(msg.uuid, 'uuid-1');
    assert.equal(msg.sessionId, 'sess-1');
    assert.equal(msg.cwd, '/tmp');
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, 'text');
    assert.equal((msg.content[0] as { text: string }).text, 'Hello world');
  });

  it('should parse an assistant message with thinking, text, and tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-2',
      parentUuid: 'uuid-1',
      timestamp: '2026-01-01T00:01:00.000Z',
      sessionId: 'sess-1',
      cwd: '/tmp',
      message: {
        model: 'claude-opus-4-6',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think...', signature: 'sig123' },
          { type: 'text', text: 'Here is my answer.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f.ts' } },
        ],
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 100,
        },
      },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal(msg.type, 'assistant');
    assert.equal(msg.model, 'claude-opus-4-6');
    assert.equal(msg.content.length, 3);
    assert.equal(msg.content[0].type, 'thinking');
    assert.equal(msg.content[1].type, 'text');
    assert.equal(msg.content[2].type, 'tool_use');
    assert.ok(msg.usage);
    assert.equal(msg.usage.input_tokens, 1000);
    assert.equal(msg.usage.output_tokens, 200);
    assert.equal(msg.usage.cache_read_input_tokens, 500);
    assert.equal(msg.usage.cache_creation_input_tokens, 100);
  });

  it('should parse a user message with tool_result content array', () => {
    const line = JSON.stringify({
      type: 'user',
      uuid: 'uuid-3',
      parentUuid: 'uuid-2',
      timestamp: '2026-01-01T00:02:00.000Z',
      sessionId: 'sess-1',
      cwd: '/tmp',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents here' },
        ],
      },
    });
    const msg = parseLine(line);
    assert.ok(msg);
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, 'tool_result');
  });

  it('should return null for lines without a message wrapper', () => {
    const line = JSON.stringify({
      type: 'system',
      uuid: 'uuid-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(parseLine(line), null);
  });
});

describe('parseTranscript', () => {
  it('should stream messages from a JSONL file, skipping non-message lines', async () => {
    const messages = [];
    for await (const msg of parseTranscript(FIXTURE_PATH)) {
      messages.push(msg);
    }

    // The fixture has: system(skip), file-history-snapshot(skip),
    // user, assistant, user(tool_result), assistant, assistant(tool_use),
    // user(tool_result rejected), assistant(tool_use), user(tool_result error),
    // malformed(skip)  = 8 messages
    assert.equal(messages.length, 8);

    // First message is the user text
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[0].content.length, 1);
    assert.equal(messages[0].content[0].type, 'text');

    // Second message is assistant with thinking + text + tool_use
    assert.equal(messages[1].type, 'assistant');
    assert.equal(messages[1].content.length, 3);
    assert.equal(messages[1].sessionId, 'sess-001');
    assert.equal(messages[1].model, 'claude-opus-4-6');

    // Third message is user with tool_result
    assert.equal(messages[2].type, 'user');
    assert.equal(messages[2].content[0].type, 'tool_result');

    // Fourth message is assistant text response
    assert.equal(messages[3].type, 'assistant');
    assert.equal(messages[3].content.length, 1);
    assert.equal(messages[3].content[0].type, 'text');
  });
});
