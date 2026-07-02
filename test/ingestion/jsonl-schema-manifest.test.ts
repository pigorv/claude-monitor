import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { findUnknownFields } from '../../src/ingestion/jsonl-schema-manifest.js';

describe('findUnknownFields', () => {
  /** A fully-known assistant record with a text block and a tool_use block. */
  function knownRecord(): Record<string, unknown> {
    return {
      type: 'assistant',
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
  }

  it('returns [] for a fully-known record', () => {
    assert.deepEqual(findUnknownFields(knownRecord()), []);
  });

  it('reports exactly the injected message.usage.__drift key', () => {
    const rec = knownRecord();
    (((rec.message as Record<string, unknown>).usage) as Record<string, unknown>).__drift = 1;

    const unknowns = findUnknownFields(rec);
    assert.deepEqual(unknowns, [{ path: 'message.usage.__drift', key: '__drift' }]);
  });

  it('does not descend into input/thinking/text leaf values', () => {
    const rec: Record<string, unknown> = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'text with words' },
          { type: 'thinking', thinking: 'text with words', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { weirdNestedKey: { deep: 1 } } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    assert.deepEqual(findUnknownFields(rec), []);
  });

  it('accepts novel ephemeral_* granularities under cache_creation', () => {
    const rec: Record<string, unknown> = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation: { ephemeral_30m_input_tokens: 5 },
        },
      },
    };
    assert.deepEqual(findUnknownFields(rec), []);
  });

  it('accepts agentId/agentType on tool_result blocks and inside toolUseResult', () => {
    const rec: Record<string, unknown> = {
      type: 'user',
      toolUseResult: { agentId: 'a1', agentType: 'general-purpose' },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'done',
            agentId: 'a1',
            agentType: 'general-purpose',
          },
        ],
      },
    };
    assert.deepEqual(findUnknownFields(rec), []);
  });

  it('reports an unknown key inside toolUseResult', () => {
    const rec: Record<string, unknown> = {
      type: 'user',
      toolUseResult: { agentId: 'a1', totalTokens: 123 },
    };
    assert.deepEqual(findUnknownFields(rec), [
      { path: 'toolUseResult.totalTokens', key: 'totalTokens' },
    ]);
  });

  it('reports unknown block keys with the full message.content[] path', () => {
    const rec: Record<string, unknown> = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi', __novel: true }],
      },
    };
    assert.deepEqual(findUnknownFields(rec), [
      { path: 'message.content[].__novel', key: '__novel' },
    ]);
  });
});
