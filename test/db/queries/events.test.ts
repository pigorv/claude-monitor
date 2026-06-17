import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb, insertSession, insertEvent } from '../../../src/db/index.js';
import { getTurnCountsForSessions, getEventTypeCounts } from '../../../src/db/queries/events.js';
import type { Session, Event } from '../../../src/shared/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    project_path: '/tmp/test',
    project_name: 'test',
    model: 'claude-sonnet-4-20250514',
    models_used: null,
    source: 'startup',
    status: 'completed',
    started_at: '2025-01-01T00:00:00.000Z',
    ended_at: '2025-01-01T01:00:00.000Z',
    duration_ms: 3600000,
    total_input_tokens: 50000,
    total_output_tokens: 10000,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_input_tokens_billed: 0,
    total_cache_write_5m_tokens: 0,
    total_cache_write_1h_tokens: 0,
    peak_context_pct: 10,
    compaction_count: 0,
    tool_call_count: 0,
    subagent_count: 0,
    summary: null,
    end_reason: null,
    transcript_path: '/tmp/t.jsonl',
    metadata: null,
    invocations: null,
    started_with: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Omit<Event, 'id'>> = {}): Omit<Event, 'id'> {
  return {
    session_id: 'sess-1',
    agent_id: null,
    event_type: 'user_message',
    event_source: 'transcript_import',
    tool_name: null,
    timestamp: '2025-01-01T00:05:00.000Z',
    sequence_num: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    context_pct: 0,
    input_preview: null,
    input_data: null,
    output_preview: null,
    output_data: null,
    thinking_summary: null,
    thinking_text: null,
    duration_ms: null,
    metadata: null,
    ...overrides,
  };
}

let tmpDir: string;

describe('getTurnCountsForSessions', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'turn-counts-test-'));
    getDb(join(tmpDir, 'test.sqlite'));
    insertSession(makeSession({ id: 'sess-1' }));
    insertSession(makeSession({ id: 'sess-2' }));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map for empty input', () => {
    const result = getTurnCountsForSessions([]);
    assert.equal(result.size, 0);
  });

  it('returns 0 for a session with no events', () => {
    const result = getTurnCountsForSessions(['sess-1']);
    assert.equal(result.get('sess-1'), 0);
  });

  it('counts user_message events with agent_id = null', () => {
    insertEvent(makeEvent({ session_id: 'sess-1', event_type: 'user_message', agent_id: null, sequence_num: 10 }));
    insertEvent(makeEvent({ session_id: 'sess-1', event_type: 'user_message', agent_id: null, sequence_num: 11 }));
    const result = getTurnCountsForSessions(['sess-1']);
    assert.equal(result.get('sess-1'), 2);
  });

  it('excludes user_message events with a non-null agent_id (subagent prompts)', () => {
    insertEvent(makeEvent({ session_id: 'sess-1', event_type: 'user_message', agent_id: 'sub-agent-1', sequence_num: 20 }));
    const result = getTurnCountsForSessions(['sess-1']);
    // The subagent event should not inflate the count
    assert.equal(result.get('sess-1'), 2);
  });

  it('excludes non-user_message events with agent_id = null', () => {
    insertEvent(makeEvent({ session_id: 'sess-1', event_type: 'assistant_message', agent_id: null, sequence_num: 30 }));
    const result = getTurnCountsForSessions(['sess-1']);
    // assistant_message should not be counted as a turn
    assert.equal(result.get('sess-1'), 2);
  });

  it('batches multiple sessions and returns independent counts', () => {
    insertEvent(makeEvent({ session_id: 'sess-2', event_type: 'user_message', agent_id: null, sequence_num: 1 }));
    const result = getTurnCountsForSessions(['sess-1', 'sess-2']);
    assert.equal(result.get('sess-1'), 2);
    assert.equal(result.get('sess-2'), 1);
  });

  it('includes requested session IDs even when they have no matching events', () => {
    const result = getTurnCountsForSessions(['sess-1', 'sess-2', 'sess-unknown']);
    assert.equal(result.has('sess-unknown'), true);
    assert.equal(result.get('sess-unknown'), 0);
  });
});

describe('getEventTypeCounts', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'type-counts-test-'));
    getDb(join(dir, 'test.sqlite'));
    insertSession(makeSession({ id: 'sess-1' }));
    // Parent events: 2 user, 3 assistant, 4 tool, 1 thinking
    for (let i = 0; i < 2; i++) insertEvent(makeEvent({ event_type: 'user_message', sequence_num: 100 + i }));
    for (let i = 0; i < 3; i++) insertEvent(makeEvent({ event_type: 'assistant_message', sequence_num: 200 + i }));
    for (let i = 0; i < 4; i++) insertEvent(makeEvent({ event_type: 'tool_call_start', tool_name: 'Bash', sequence_num: 300 + i }));
    insertEvent(makeEvent({ event_type: 'thinking', sequence_num: 400 }));
    // Sub-agent events that must be excluded under parentOnly
    insertEvent(makeEvent({ event_type: 'user_message', agent_id: 'sub-1', sequence_num: 500 }));
    insertEvent(makeEvent({ event_type: 'tool_call_start', tool_name: 'Read', agent_id: 'sub-1', sequence_num: 501 }));
  });

  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts each type and rolls every event (incl. thinking) into all (parent-only)', () => {
    const c = getEventTypeCounts('sess-1', true);
    assert.equal(c.user_message, 2);
    assert.equal(c.assistant_message, 3);
    assert.equal(c.tool_call_start, 4);
    // all includes the thinking event too: 2 + 3 + 4 + 1
    assert.equal(c.all, 10);
  });

  it('includes sub-agent events when parentOnly is false', () => {
    const c = getEventTypeCounts('sess-1', false);
    assert.equal(c.user_message, 3); // +1 sub-agent
    assert.equal(c.tool_call_start, 5); // +1 sub-agent
    assert.equal(c.all, 12);
  });

  it('returns all-zero counts for a session with no events', () => {
    insertSession(makeSession({ id: 'empty' }));
    const c = getEventTypeCounts('empty', true);
    assert.deepEqual(c, { all: 0, user_message: 0, assistant_message: 0, tool_call_start: 0 });
  });
});
