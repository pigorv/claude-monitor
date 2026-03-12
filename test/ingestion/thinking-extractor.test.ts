import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractThinkingBlocks, extractAllEvents } from '../../src/ingestion/thinking-extractor.js';
import type { TranscriptMessage } from '../../src/shared/types.js';

function makeMsg(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    uuid: 'uuid-1',
    parentUuid: null,
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    content: [],
    ...overrides,
  };
}

describe('extractThinkingBlocks', () => {
  it('should extract thinking blocks from an assistant message', () => {
    const msg = makeMsg({
      content: [
        { type: 'thinking', thinking: 'Let me think about this carefully.' },
        { type: 'text', text: 'Here is my answer.' },
      ],
    });

    const events = extractThinkingBlocks(msg);
    assert.equal(events.length, 1);
    assert.equal(events[0].thinking_text, 'Let me think about this carefully.');
    assert.equal(events[0].thinking_summary, 'Let me think about this carefully.');
    assert.equal(events[0].sequence_num, 0);
  });

  it('should truncate thinking_summary to 200 chars', () => {
    const longThinking = 'A'.repeat(300);
    const msg = makeMsg({
      content: [{ type: 'thinking', thinking: longThinking }],
    });

    const events = extractThinkingBlocks(msg);
    assert.equal(events[0].thinking_summary.length, 200);
    assert.ok(events[0].thinking_summary.endsWith('...'));
  });

  it('should skip empty thinking blocks', () => {
    const msg = makeMsg({
      content: [{ type: 'thinking', thinking: '' }],
    });

    const events = extractThinkingBlocks(msg);
    assert.equal(events.length, 0);
  });

  it('should handle multiple thinking blocks', () => {
    const msg = makeMsg({
      content: [
        { type: 'thinking', thinking: 'First thought.' },
        { type: 'text', text: 'Response.' },
        { type: 'thinking', thinking: 'Second thought.' },
      ],
    });

    const events = extractThinkingBlocks(msg);
    assert.equal(events.length, 2);
    assert.equal(events[0].sequence_num, 0);
    assert.equal(events[1].sequence_num, 1);
  });
});

describe('extractAllEvents', () => {
  it('should extract events from a full conversation', () => {
    const messages: TranscriptMessage[] = [
      makeMsg({
        type: 'user',
        uuid: 'u1',
        content: [{ type: 'text', text: 'Read my file please.' }],
      }),
      makeMsg({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        content: [
          { type: 'thinking', thinking: 'The user wants me to read a file.' },
          { type: 'text', text: "I'll read that." },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/f.ts' } },
        ],
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
      }),
      makeMsg({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'const x = 1;' },
        ],
      }),
      makeMsg({
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u2',
        content: [{ type: 'text', text: 'The file defines x as 1.' }],
        usage: { input_tokens: 1500, output_tokens: 50 },
      }),
    ];

    const events = extractAllEvents(messages);

    // Expected event sequence:
    // 1. user_message (from u1)
    // 2. thinking (from a1)
    // 3. tool_call_start (from a1 tool_use)
    // 4. assistant_message (from a1 text)
    // 5. tool_call_end (from u2 tool_result)
    // 6. assistant_message (from a2 text)
    assert.equal(events.length, 6);

    assert.equal(events[0].event_type, 'user_message');
    assert.equal(events[0].input_preview, 'Read my file please.');

    assert.equal(events[1].event_type, 'thinking');
    assert.equal(events[1].thinking_text, 'The user wants me to read a file.');

    assert.equal(events[2].event_type, 'tool_call_start');
    assert.equal(events[2].tool_name, 'Read');
    assert.ok(events[2].input_data?.includes('file_path'));

    assert.equal(events[3].event_type, 'assistant_message');
    assert.equal(events[3].input_tokens, 1000);
    assert.equal(events[3].output_tokens, 200);
    assert.equal(events[3].cache_read_tokens, 500);

    assert.equal(events[4].event_type, 'tool_call_end');
    assert.equal(events[4].tool_name, 'Read');
    assert.equal(events[4].output_preview, 'const x = 1;');

    assert.equal(events[5].event_type, 'assistant_message');
    assert.equal(events[5].input_tokens, 1500);
  });

  it('should handle user message with both text and tool_result', () => {
    const messages: TranscriptMessage[] = [
      makeMsg({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'ls' } },
        ],
      }),
      makeMsg({
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-2', content: 'file1.ts\nfile2.ts' },
          { type: 'text', text: 'Now also do this other thing.' },
        ],
      }),
    ];

    const events = extractAllEvents(messages);

    const toolStart = events.find((e) => e.event_type === 'tool_call_start');
    assert.ok(toolStart);
    assert.equal(toolStart.tool_name, 'Bash');

    const toolEnd = events.find((e) => e.event_type === 'tool_call_end');
    assert.ok(toolEnd);
    assert.equal(toolEnd.tool_name, 'Bash');

    const userMsg = events.find((e) => e.event_type === 'user_message');
    assert.ok(userMsg);
    assert.equal(userMsg.input_preview, 'Now also do this other thing.');
  });

  it('should truncate long input/output previews', () => {
    const longInput = JSON.stringify({ data: 'X'.repeat(600) });
    const messages: TranscriptMessage[] = [
      makeMsg({
        type: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-3', name: 'Write', input: { data: 'X'.repeat(600) } },
        ],
      }),
      makeMsg({
        type: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-3', content: 'Y'.repeat(600) },
        ],
      }),
    ];

    const events = extractAllEvents(messages);
    const start = events.find((e) => e.event_type === 'tool_call_start');
    assert.ok(start);
    assert.equal(start.input_preview!.length, 500);
    assert.ok(start.input_preview!.endsWith('...'));
    // input_data should be the full JSON
    assert.ok(start.input_data!.length > 500);

    const end = events.find((e) => e.event_type === 'tool_call_end');
    assert.ok(end);
    assert.equal(end.output_preview!.length, 500);
    assert.ok(end.output_preview!.endsWith('...'));
    assert.equal(end.output_data!.length, 600);
  });

  it('should return empty array for empty input', () => {
    assert.deepEqual(extractAllEvents([]), []);
  });
});
