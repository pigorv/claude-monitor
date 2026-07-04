import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb, insertSession, insertEvent } from '../../../src/db/index.js';
import {
  getTokenTimeline,
  getMiniTimeline,
  getMiniTimelinesForSessions,
  getTokenTimelineAnnotations,
  collapseTimelineByUsage,
} from '../../../src/db/queries/events.js';
import {
  getAgentTokenTimeline,
  getAllAgentTokenTimelines,
} from '../../../src/db/queries/sessions.js';
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
    event_type: 'assistant_message',
    event_source: 'transcript_import',
    tool_name: null,
    timestamp: '2025-01-01T00:05:00.000Z',
    sequence_num: 1,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 200,
    cache_write_tokens: 100,
    context_pct: 10,
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

// ── collapseTimelineByUsage (unit) ─────────────────────────────────

describe('collapseTimelineByUsage', () => {
  function row(over: Partial<{
    input_tokens: number; output_tokens: number; cache_read_tokens: number;
    cache_write_tokens: number; event_type: string; is_compaction: number; tag: string;
  }> = {}) {
    return {
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100,
      event_type: 'assistant_message', is_compaction: 0, tag: 'a', ...over,
    };
  }

  it('collapses a run of consecutive identical-usage rows to one point (first member kept)', () => {
    const rows = [
      row({ tag: 'first' }),
      row({ tag: 'second' }),
      row({ tag: 'third' }),
    ];
    const out = collapseTimelineByUsage(rows);
    assert.equal(out.length, 1);
    // The earliest member of the run is the kept point.
    assert.equal(out[0].tag, 'first');
  });

  it('keeps rows with distinct usage as separate points (no over-merge)', () => {
    const rows = [
      row({ input_tokens: 1000, tag: 'turn-1' }),
      row({ input_tokens: 2000, tag: 'turn-2' }),
      row({ input_tokens: 3000, tag: 'turn-3' }),
    ];
    const out = collapseTimelineByUsage(rows);
    assert.equal(out.length, 3);
  });

  it('does not merge two non-adjacent runs that happen to share a signature', () => {
    const rows = [
      row({ input_tokens: 1000, tag: 'a1' }),
      row({ input_tokens: 1000, tag: 'a2' }), // collapses into a1
      row({ input_tokens: 2000, tag: 'b' }),
      row({ input_tokens: 1000, tag: 'c' }), // same sig as a-run but not adjacent → own point
    ];
    const out = collapseTimelineByUsage(rows);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((r) => r.tag), ['a1', 'b', 'c']);
  });

  it('OR-folds compaction onto the kept point when any run member is a compaction', () => {
    const rows = [
      row({ tag: 'first', event_type: 'assistant_message', is_compaction: 0 }),
      row({ tag: 'second', event_type: 'compaction', is_compaction: 1 }),
    ];
    const out = collapseTimelineByUsage(rows);
    assert.equal(out.length, 1);
    assert.equal(out[0].event_type, 'compaction');
    assert.ok(out[0].is_compaction);
  });
});

// ── getTokenTimeline (Behavior #1, #2) ─────────────────────────────

describe('getTokenTimeline collapse', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'timeline-collapse-'));
    getDb(join(dir, 'test.sqlite'));
    insertSession(makeSession({ id: 'sess-1' }));

    // Turn 1: a streamed assistant turn written as 3 JSONL lines (thinking /
    // text / tool_use blocks). IDENTICAL usage, timestamps ~2 ms apart,
    // increasing sequence_num.
    insertEvent(makeEvent({
      sequence_num: 1, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.000Z',
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100,
    }));
    insertEvent(makeEvent({
      sequence_num: 2, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.002Z',
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100,
    }));
    insertEvent(makeEvent({
      sequence_num: 3, event_type: 'tool_call_start', tool_name: 'Read',
      timestamp: '2025-01-01T00:05:00.004Z',
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100,
    }));

    // Turn 2: a distinct API turn with different usage → must stay separate.
    insertEvent(makeEvent({
      sequence_num: 4, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:06:00.000Z',
      input_tokens: 5000, output_tokens: 800, cache_read_tokens: 4000, cache_write_tokens: 300,
    }));
    insertEvent(makeEvent({
      sequence_num: 5, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:06:00.002Z',
      input_tokens: 5000, output_tokens: 800, cache_read_tokens: 4000, cache_write_tokens: 300,
    }));
  });

  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns exactly one point per real API turn (Behavior #1)', () => {
    const timeline = getTokenTimeline('sess-1');
    assert.equal(timeline.length, 2, 'two streamed turns should collapse to two points');
    // Earliest member's timestamp is preserved for each turn.
    assert.equal(timeline[0].timestamp, '2025-01-01T00:05:00.000Z');
    assert.equal(timeline[1].timestamp, '2025-01-01T00:06:00.000Z');
  });

  it('getMiniTimeline applies the same collapse before downsampling (Behavior #3)', () => {
    // Reuse the sess-1 fixture (shared open handle): 5 streamed rows → 2 points.
    const mini = getMiniTimeline('sess-1');
    assert.equal(mini.length, 2, 'mini timeline collapses the streamed rows too');
  });
});

// ── Compaction OR-fold (Behavior #2) ───────────────────────────────

describe('getTokenTimeline compaction fold', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'timeline-compaction-'));
    getDb(join(dir, 'test.sqlite'));
    insertSession(makeSession({ id: 'comp-sess' }));

    // A normal turn, then a compaction turn (its large input-token drop gives it
    // a distinct usage signature, so it forms its own point). One of its streamed
    // rows carries event_type='compaction' which must OR-fold onto the point.
    insertEvent(makeEvent({
      session_id: 'comp-sess', sequence_num: 1, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.000Z',
      input_tokens: 150000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
    insertEvent(makeEvent({
      session_id: 'comp-sess', sequence_num: 2, event_type: 'compaction',
      timestamp: '2025-01-01T00:06:00.000Z',
      input_tokens: 20000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
    insertEvent(makeEvent({
      session_id: 'comp-sess', sequence_num: 3, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:06:00.002Z',
      input_tokens: 20000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
  });

  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks the collapsed point as compaction when any run member is a compaction (Behavior #2)', () => {
    const timeline = getTokenTimeline('comp-sess');
    const compactionPoint = timeline.find((p) => p.is_compaction);
    assert.ok(compactionPoint, 'a collapsed compaction point should exist');
    assert.equal(compactionPoint.event_type, 'compaction');
    assert.ok(compactionPoint.is_compaction);
  });
});

// ── Agent timelines (Behavior #4) ──────────────────────────────────

describe('agent timeline collapse', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-timeline-collapse-'));
    getDb(join(dir, 'test.sqlite'));
    insertSession(makeSession({ id: 'sess-1' }));

    // Agent A: one streamed turn (3 identical-usage rows) + a distinct turn.
    insertEvent(makeEvent({
      agent_id: 'agent-a', sequence_num: 1, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.000Z',
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
    insertEvent(makeEvent({
      agent_id: 'agent-a', sequence_num: 2, event_type: 'tool_call_start', tool_name: 'Read',
      timestamp: '2025-01-01T00:05:00.002Z',
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
    insertEvent(makeEvent({
      agent_id: 'agent-a', sequence_num: 3, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.004Z',
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
    insertEvent(makeEvent({
      agent_id: 'agent-a', sequence_num: 4, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:06:00.000Z',
      input_tokens: 3000, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0,
    }));

    // Agent B: one streamed turn (2 identical-usage rows).
    insertEvent(makeEvent({
      agent_id: 'agent-b', sequence_num: 5, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:07:00.000Z',
      input_tokens: 9000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
    insertEvent(makeEvent({
      agent_id: 'agent-b', sequence_num: 6, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:07:00.002Z',
      input_tokens: 9000, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0,
    }));

    // Agent C: two adjacent turns that differ ONLY in cache_write_tokens. The
    // collapse signature must include cache_write or these wrongly merge into one.
    insertEvent(makeEvent({
      agent_id: 'agent-c', sequence_num: 7, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:08:00.000Z',
      input_tokens: 2000, output_tokens: 200, cache_read_tokens: 100, cache_write_tokens: 500,
    }));
    insertEvent(makeEvent({
      agent_id: 'agent-c', sequence_num: 8, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:08:01.000Z',
      input_tokens: 2000, output_tokens: 200, cache_read_tokens: 100, cache_write_tokens: 0,
    }));
  });

  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('getAgentTokenTimeline collapses one agent\'s streamed rows per turn (Behavior #4)', () => {
    const timeline = getAgentTokenTimeline('sess-1', 'agent-a');
    assert.equal(timeline.length, 2, 'agent-a: 3-row turn + 1 distinct turn → 2 points');
    assert.equal(timeline[0].timestamp, '2025-01-01T00:05:00.000Z');
  });

  it('getAllAgentTokenTimelines collapses each agent independently (Behavior #4)', () => {
    const map = getAllAgentTokenTimelines('sess-1');
    assert.equal(map.get('agent-a')?.length, 2, 'agent-a collapses to 2 points');
    assert.equal(map.get('agent-b')?.length, 1, 'agent-b collapses to 1 point');
  });

  it('keeps agent turns that differ only in cache_write_tokens as separate points', () => {
    // Guards the agent SELECT including cache_write_tokens in the collapse signature.
    assert.equal(getAgentTokenTimeline('sess-1', 'agent-c').length, 2,
      'agent-c: two turns differing only in cache_write must not merge');
    const map = getAllAgentTokenTimelines('sess-1');
    assert.equal(map.get('agent-c')?.length, 2, 'agent-c stays 2 points via getAll too');
  });
});

// ── Batch mini-timeline parity (T1.1 Behaviors #1–#4, #7) ──────────

describe('getMiniTimelinesForSessions parity with getMiniTimeline', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mini-batch-parity-'));
    getDb(join(dir, 'test.sqlite'));
    insertSession(makeSession({ id: 'batch-sess' }));

    // Turn 1: one streamed API turn written as 3 identical-usage JSONL lines
    // (thinking / text / tool_use), timestamps ~2 ms apart.
    insertEvent(makeEvent({
      session_id: 'batch-sess', sequence_num: 1, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.000Z', context_pct: 10,
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100,
    }));
    insertEvent(makeEvent({
      session_id: 'batch-sess', sequence_num: 2, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.002Z', context_pct: 10,
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100,
    }));
    insertEvent(makeEvent({
      session_id: 'batch-sess', sequence_num: 3, event_type: 'tool_call_start', tool_name: 'Read',
      timestamp: '2025-01-01T00:05:00.004Z', context_pct: 10,
      input_tokens: 1000, output_tokens: 500, cache_read_tokens: 200, cache_write_tokens: 100,
    }));

    // Turn 2: a distinct real turn (different usage).
    insertEvent(makeEvent({
      session_id: 'batch-sess', sequence_num: 4, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:06:00.000Z', context_pct: 22,
      input_tokens: 5000, output_tokens: 800, cache_read_tokens: 4000, cache_write_tokens: 300,
    }));

    // Trailing synthetic zero-usage assistant row (all four usage columns 0). It
    // still carries a context_pct, so the zero-usage guard — not a NULL check —
    // is what must drop it. Inserted raw; no ingestion is re-run (Behavior #7).
    insertEvent(makeEvent({
      session_id: 'batch-sess', sequence_num: 5, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:07:00.000Z', context_pct: 0,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    }));
  });

  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('batch series deep-equals the single-session series (Behavior #1)', () => {
    const batch = getMiniTimelinesForSessions(['batch-sess']).get('batch-sess');
    const single = getMiniTimeline('batch-sess');
    assert.deepEqual(batch, single);
  });

  it('batch series has no trailing 0-context point (Behavior #2/#7)', () => {
    const batch = getMiniTimelinesForSessions(['batch-sess']).get('batch-sess');
    assert.ok(batch && batch.length > 0);
    assert.notEqual(batch[batch.length - 1].context_pct, 0,
      'the synthetic zero-usage tail row must be filtered at read time');
  });

  it('streamed duplicate rows collapse to one point in the batch path (Behavior #3)', () => {
    const batch = getMiniTimelinesForSessions(['batch-sess']).get('batch-sess');
    const single = getMiniTimeline('batch-sess');
    // 3 streamed rows + 1 distinct turn + dropped zero row → 2 points.
    assert.equal(batch?.length, 2);
    assert.equal(batch?.length, single.length);
  });
});

describe('getMiniTimelinesForSessions downsampling preserves compaction', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mini-batch-compaction-'));
    getDb(join(dir, 'test.sqlite'));
    insertSession(makeSession({ id: 'comp-batch' }));

    // 40 distinct real turns (each a unique usage tuple so nothing collapses),
    // far exceeding maxPoints=20, with a compaction turn positioned near the end
    // (well past where uniform sampling would land a kept index).
    for (let i = 0; i < 40; i++) {
      const isComp = i === 38;
      insertEvent(makeEvent({
        session_id: 'comp-batch', sequence_num: i + 1,
        event_type: isComp ? 'compaction' : 'assistant_message',
        timestamp: `2025-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        context_pct: 10 + i,
        input_tokens: 1000 + i * 100, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0,
      }));
    }
  });

  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a compaction row past maxPoints survives downsampling in the batch series (Behavior #4)', () => {
    const batch = getMiniTimelinesForSessions(['comp-batch'], 20).get('comp-batch');
    assert.ok(batch && batch.length <= 20);
    assert.ok(batch.some((p) => p.is_compaction),
      'the compaction point must be preserved by the downsampler');
  });

  it('matches the single-session series for the same session (Behavior #1)', () => {
    const batch = getMiniTimelinesForSessions(['comp-batch'], 20).get('comp-batch');
    const single = getMiniTimeline('comp-batch', 20);
    assert.deepEqual(batch, single);
  });
});

// ── Annotations (Behavior #5) ──────────────────────────────────────

describe('getTokenTimelineAnnotations', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'annotations-test-'));
    getDb(join(dir, 'test.sqlite'));
    insertSession(makeSession({ id: 'sess-1' }));

    insertEvent(makeEvent({
      sequence_num: 1, event_type: 'assistant_message',
      timestamp: '2025-01-01T00:05:00.000Z',
    }));
    insertEvent(makeEvent({
      sequence_num: 2, event_type: 'tool_call_start', tool_name: 'Read',
      timestamp: '2025-01-01T00:05:00.500Z',
      input_data: JSON.stringify({ file_path: '/tmp/foo.ts' }),
    }));
    insertEvent(makeEvent({
      sequence_num: 3, event_type: 'tool_call_start', tool_name: 'Bash',
      timestamp: '2025-01-01T00:05:01.000Z',
      input_preview: 'command: npm test',
    }));
    // A tool_call_start with no tool_name must be skipped.
    insertEvent(makeEvent({
      sequence_num: 4, event_type: 'tool_call_start', tool_name: null,
      timestamp: '2025-01-01T00:05:02.000Z',
    }));
  });

  afterAll(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits one annotation per named tool_call_start, each carrying a timestamp and no index (Behavior #5)', () => {
    const annotations = getTokenTimelineAnnotations('sess-1');
    assert.equal(annotations.length, 2, 'one per named tool_call_start; the null-tool row is skipped');

    const readAnn = annotations.find((a) => a.tool_name === 'Read');
    assert.ok(readAnn);
    assert.equal(readAnn.timestamp, '2025-01-01T00:05:00.500Z');
    assert.equal(readAnn.marker_type, 'file_read');
    // The type's `index` field was replaced with `timestamp` — it must not appear.
    assert.ok(!('index' in readAnn), 'annotation must not carry a legacy index field');

    const bashAnn = annotations.find((a) => a.tool_name === 'Bash');
    assert.ok(bashAnn);
    assert.equal(bashAnn.timestamp, '2025-01-01T00:05:01.000Z');
    assert.equal(bashAnn.marker_type, 'bash');
  });
});
