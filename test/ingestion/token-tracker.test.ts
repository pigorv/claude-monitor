import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveThreshold,
  estimateContextPct,
  buildTokenSnapshots,
  computeAggregates,
  snapshotsToDataPoints,
} from '../../src/ingestion/token-tracker.js';
import type { TranscriptMessage } from '../../src/shared/types.js';

// ── Helper to create assistant messages with usage ─────────────────

function assistantMsg(opts: {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read?: number;
  cache_write?: number;
  model?: string;
}): TranscriptMessage {
  return {
    uuid: `uuid-${opts.timestamp}`,
    parentUuid: null,
    type: 'assistant',
    timestamp: opts.timestamp,
    model: opts.model,
    content: [{ type: 'text', text: 'response' }],
    usage: {
      input_tokens: opts.input_tokens,
      output_tokens: opts.output_tokens,
      cache_read_input_tokens: opts.cache_read ?? 0,
      cache_creation_input_tokens: opts.cache_write ?? 0,
    },
  };
}

function userMsg(timestamp: string): TranscriptMessage {
  return {
    uuid: `uuid-user-${timestamp}`,
    parentUuid: null,
    type: 'user',
    timestamp,
    content: [{ type: 'text', text: 'hello' }],
  };
}

// ── resolveThreshold ───────────────────────────────────────────────

describe('resolveThreshold', () => {
  it('resolves opus from full model string', () => {
    const t = resolveThreshold('claude-opus-4-6');
    assert.equal(t.model, 'opus');
    assert.equal(t.maxTokens, 200_000);
  });

  it('resolves sonnet from model string', () => {
    const t = resolveThreshold('claude-sonnet-4-6');
    assert.equal(t.model, 'sonnet');
  });

  it('resolves haiku from model string', () => {
    const t = resolveThreshold('claude-haiku-4-5-20251001');
    assert.equal(t.model, 'haiku');
  });

  it('defaults to sonnet for unknown model', () => {
    const t = resolveThreshold('gpt-4o');
    assert.equal(t.model, 'sonnet');
  });

  it('defaults to sonnet for null/undefined', () => {
    assert.equal(resolveThreshold(null).model, 'sonnet');
    assert.equal(resolveThreshold(undefined).model, 'sonnet');
  });
});

// ── estimateContextPct ─────────────────────────────────────────────

describe('estimateContextPct', () => {
  it('computes percentage of max tokens', () => {
    // sonnet has 200k max
    const pct = estimateContextPct(100_000, 'claude-sonnet-4-6');
    assert.equal(pct, 50);
  });

  it('returns 100 at max capacity', () => {
    const pct = estimateContextPct(200_000, 'claude-sonnet-4-6');
    assert.equal(pct, 100);
  });

  it('returns 0 for zero tokens', () => {
    assert.equal(estimateContextPct(0, 'opus'), 0);
  });
});

// ── buildTokenSnapshots ────────────────────────────────────────────

describe('buildTokenSnapshots', () => {
  it('builds snapshots from assistant messages only', () => {
    const messages: TranscriptMessage[] = [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 1000, output_tokens: 200 }),
      userMsg('2026-01-01T00:02:00Z'),
      assistantMsg({ timestamp: '2026-01-01T00:03:00Z', input_tokens: 2000, output_tokens: 300 }),
    ];

    const snapshots = buildTokenSnapshots(messages);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].input_tokens, 1000);
    assert.equal(snapshots[0].output_tokens, 200);
    assert.equal(snapshots[1].input_tokens, 2000);
    assert.equal(snapshots[1].output_tokens, 300);
  });

  it('skips messages without usage', () => {
    const messages: TranscriptMessage[] = [
      {
        uuid: 'a', parentUuid: null, type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
        content: [{ type: 'text', text: 'hi' }],
        // no usage
      },
    ];
    const snapshots = buildTokenSnapshots(messages);
    assert.equal(snapshots.length, 0);
  });

  it('detects compaction from >30% input token drop', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 100_000, output_tokens: 500 }),
      assistantMsg({ timestamp: '2026-01-01T00:02:00Z', input_tokens: 50_000, output_tokens: 200 }), // 50% drop
    ];

    const snapshots = buildTokenSnapshots(messages);
    assert.equal(snapshots[0].is_compaction, false);
    assert.equal(snapshots[1].is_compaction, true);
  });

  it('does not flag small drops as compaction', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 100_000, output_tokens: 500 }),
      assistantMsg({ timestamp: '2026-01-01T00:02:00Z', input_tokens: 80_000, output_tokens: 200 }), // 20% drop
    ];

    const snapshots = buildTokenSnapshots(messages);
    assert.equal(snapshots[1].is_compaction, false);
  });

  it('computes context_pct using model', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 150_000, output_tokens: 100 }),
    ];

    const snapshots = buildTokenSnapshots(messages, 'claude-sonnet-4-6');
    assert.equal(snapshots[0].context_pct, 75); // 150k / 200k
  });

  it('tracks cache tokens', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 1000, output_tokens: 100, cache_read: 500, cache_write: 200 }),
    ];

    const snapshots = buildTokenSnapshots(messages);
    assert.equal(snapshots[0].cache_read_tokens, 500);
    assert.equal(snapshots[0].cache_write_tokens, 200);
  });
});

// ── computeAggregates ──────────────────────────────────────────────

describe('computeAggregates', () => {
  it('returns zeros for empty snapshots', () => {
    const agg = computeAggregates([]);
    assert.equal(agg.total_input_tokens, 0);
    assert.equal(agg.total_output_tokens, 0);
    assert.equal(agg.compaction_count, 0);
  });

  it('computes aggregates correctly', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 1000, output_tokens: 200, cache_read: 500, cache_write: 100 }),
      assistantMsg({ timestamp: '2026-01-01T00:02:00Z', input_tokens: 2000, output_tokens: 300, cache_read: 800, cache_write: 50 }),
    ];

    const snapshots = buildTokenSnapshots(messages);
    const agg = computeAggregates(snapshots);

    assert.equal(agg.total_input_tokens, 2850); // max effective context (input + cache_read + cache_write)
    assert.equal(agg.total_output_tokens, 500); // 200 + 300, summed
    assert.equal(agg.total_cache_read_tokens, 1300); // 500 + 800
    assert.equal(agg.total_cache_write_tokens, 150); // 100 + 50
    assert.equal(agg.compaction_count, 0);
  });

  it('counts compactions', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 100_000, output_tokens: 500 }),
      assistantMsg({ timestamp: '2026-01-01T00:02:00Z', input_tokens: 40_000, output_tokens: 200 }), // compaction
      assistantMsg({ timestamp: '2026-01-01T00:03:00Z', input_tokens: 90_000, output_tokens: 300 }),
      assistantMsg({ timestamp: '2026-01-01T00:04:00Z', input_tokens: 30_000, output_tokens: 100 }), // compaction
    ];

    const snapshots = buildTokenSnapshots(messages);
    const agg = computeAggregates(snapshots);
    assert.equal(agg.compaction_count, 2);
  });

  it('tracks peak context pct', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 150_000, output_tokens: 100 }),
      assistantMsg({ timestamp: '2026-01-01T00:02:00Z', input_tokens: 50_000, output_tokens: 100 }), // compaction
    ];

    const snapshots = buildTokenSnapshots(messages, 'claude-sonnet-4-6');
    const agg = computeAggregates(snapshots);
    assert.equal(agg.peak_context_pct, 75); // 150k / 200k
  });
});

// ── snapshotsToDataPoints ──────────────────────────────────────────

describe('snapshotsToDataPoints', () => {
  it('converts snapshots to data points', () => {
    const messages: TranscriptMessage[] = [
      assistantMsg({ timestamp: '2026-01-01T00:01:00Z', input_tokens: 100_000, output_tokens: 500 }),
      assistantMsg({ timestamp: '2026-01-01T00:02:00Z', input_tokens: 40_000, output_tokens: 200 }), // compaction
    ];

    const snapshots = buildTokenSnapshots(messages);
    const dataPoints = snapshotsToDataPoints(snapshots);

    assert.equal(dataPoints.length, 2);
    assert.equal(dataPoints[0].event_type, 'assistant_message');
    assert.equal(dataPoints[0].is_compaction, false);
    assert.equal(dataPoints[1].event_type, 'compaction');
    assert.equal(dataPoints[1].is_compaction, true);
  });
});
