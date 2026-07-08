import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { computeAgentEfficiency, classifyResultSize } from '../../src/analysis/agent-efficiency.js';
import { findParentTokensAtReturn } from '../../src/ingestion/transcript-importer.js';
import type { Event } from '../../src/shared/types.js';

/** Build a minimal parent Event (sans id) carrying only the token fields the
 *  effective-context calculation reads. */
function makeEvent(overrides: Partial<Omit<Event, 'id'>>): Omit<Event, 'id'> {
  return {
    session_id: 's1',
    agent_id: null,
    event_type: 'assistant_message',
    event_source: 'transcript_import',
    tool_name: null,
    timestamp: '2026-07-06T00:00:00.000Z',
    sequence_num: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    context_pct: null,
    input_preview: null,
    input_data: null,
    output_preview: null,
    output_data: null,
    thinking_summary: null,
    thinking_text: null,
    duration_ms: null,
    metadata: null,
    ...overrides,
  } as Omit<Event, 'id'>;
}

describe('findParentTokensAtReturn', () => {
  // Behavior #2: gh-100 evidence event → effective context 44620.
  it('returns effective context (input + cache read + cache write) for the first post-return event', () => {
    const events = [
      makeEvent({
        timestamp: '2026-07-06T00:00:10.000Z',
        input_tokens: 1,
        cache_read_tokens: 43685,
        cache_write_tokens: 934,
      }),
    ];
    const tokens = findParentTokensAtReturn(events, '2026-07-06T00:00:05.000Z');
    assert.equal(tokens, 44620);
  });

  // Behavior #3: null cache components → exactly input_tokens, no NaN.
  it('returns exactly input_tokens when cache components are null', () => {
    const events = [
      makeEvent({
        timestamp: '2026-07-06T00:00:10.000Z',
        input_tokens: 1200,
        cache_read_tokens: null,
        cache_write_tokens: null,
      }),
    ];
    const tokens = findParentTokensAtReturn(events, '2026-07-06T00:00:05.000Z');
    assert.equal(tokens, 1200);
    assert.ok(!Number.isNaN(tokens as number));
  });

  // Behavior #1: fallback loop also uses effective context.
  it('falls back to the last pre-return event using effective context', () => {
    const events = [
      makeEvent({
        timestamp: '2026-07-06T00:00:01.000Z',
        input_tokens: 2,
        cache_read_tokens: 100,
        cache_write_tokens: 50,
      }),
      makeEvent({
        timestamp: '2026-07-06T00:00:02.000Z',
        input_tokens: 3,
        cache_read_tokens: 1000,
        cache_write_tokens: 200,
      }),
    ];
    // agent end is after both events → no forward match → fallback to last
    const tokens = findParentTokensAtReturn(events, '2026-07-06T00:00:59.000Z');
    assert.equal(tokens, 1203);
  });
});

describe('computeAgentEfficiency parent headroom', () => {
  // Behavior #2: 44620 effective context against a 200k model → headroom 155380.
  it('derives parent_headroom_at_return from effective context', () => {
    const result = computeAgentEfficiency(null, null, [], 44620, null);
    assert.equal(result.parent_headroom_at_return, 155380);
  });
});

describe('classifyResultSize against corrected headroom', () => {
  // Behavior #4: with the corrected (smaller) headroom the large/oversized bands fire.
  const headroom = 155380;

  it('classifies a result just over 5% of true headroom as large', () => {
    // 9000 / 155380 ≈ 5.79%
    assert.equal(classifyResultSize(9000, headroom), 'large');
  });

  it('classifies a result over 15% of true headroom as oversized', () => {
    // 25000 / 155380 ≈ 16.09%
    assert.equal(classifyResultSize(25000, headroom), 'oversized');
  });

  it('classifies a small result as normal', () => {
    // 5000 / 155380 ≈ 3.22%
    assert.equal(classifyResultSize(5000, headroom), 'normal');
  });
});
