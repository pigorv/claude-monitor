import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { computeRiskAssessment, riskLevel } from '../../src/analysis/risk-scoring.js';
import type { TokenSnapshot } from '../../src/ingestion/token-tracker.js';
import type { ParsedEvent } from '../../src/ingestion/thinking-extractor.js';

// ── Helpers ─────────────────────────────────────────────────────────

function snap(context_pct: number, is_compaction = false, timestamp = '2024-01-01T00:00:00Z'): TokenSnapshot {
  return {
    timestamp,
    input_tokens: 100_000,
    output_tokens: 1_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    context_pct,
    is_compaction,
  };
}

function toolCallEvent(opts: {
  timestamp?: string;
  tool_name?: string;
  output_data?: string;
  event_type?: string;
} = {}): ParsedEvent {
  return {
    event_type: (opts.event_type ?? 'tool_call_start') as ParsedEvent['event_type'],
    timestamp: opts.timestamp ?? '2024-01-01T00:00:00Z',
    tool_name: opts.tool_name ?? 'Read',
    input_preview: null,
    input_data: null,
    output_preview: null,
    output_data: opts.output_data ?? null,
    thinking_summary: null,
    thinking_text: null,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('riskLevel', () => {
  it('maps scores to correct levels', () => {
    assert.equal(riskLevel(0), 'low');
    assert.equal(riskLevel(0.29), 'low');
    assert.equal(riskLevel(0.3), 'medium');
    assert.equal(riskLevel(0.59), 'medium');
    assert.equal(riskLevel(0.6), 'high');
    assert.equal(riskLevel(0.79), 'high');
    assert.equal(riskLevel(0.8), 'critical');
    assert.equal(riskLevel(1.0), 'critical');
  });
});

describe('computeRiskAssessment', () => {
  it('returns near-zero score for zero-risk session', () => {
    const result = computeRiskAssessment({
      snapshots: [snap(20), snap(30)],
      events: [],
      model: 'claude-sonnet-4-5',
      compactionCount: 0,
      subagentCount: 0,
    });

    assert.ok(result.score < 0.05, `Expected near 0, got ${result.score}`);
    assert.equal(result.level, 'low');
    assert.equal(result.signals.length, 5);
  });

  it('maxes compaction signal at 3+ compactions', () => {
    const result = computeRiskAssessment({
      snapshots: [snap(20)],
      events: [],
      model: null,
      compactionCount: 5,
      subagentCount: 0,
    });

    const compactionSignal = result.signals.find((s) => s.name === 'compaction_count');
    assert.ok(compactionSignal);
    assert.equal(compactionSignal.value, 1.0);
  });

  it('produces high context signal for high utilization', () => {
    // Sonnet warning=65%, peak=95% → score = (95-65)/(100-65) ≈ 0.857
    const result = computeRiskAssessment({
      snapshots: [snap(50), snap(95)],
      events: [],
      model: 'claude-sonnet-4-5',
      compactionCount: 0,
      subagentCount: 0,
    });

    const ctxSignal = result.signals.find((s) => s.name === 'context_utilization');
    assert.ok(ctxSignal);
    assert.ok(ctxSignal.value > 0.8, `Expected > 0.8, got ${ctxSignal.value}`);
  });

  it('computes composite as weighted sum', () => {
    const result = computeRiskAssessment({
      snapshots: [snap(20)],
      events: [],
      model: null,
      compactionCount: 0,
      subagentCount: 0,
    });

    // Manual calculation: all signals should be 0 or near 0
    let expectedScore = 0;
    for (const s of result.signals) {
      expectedScore += s.value * s.weight;
    }
    expectedScore = Math.round(Math.min(Math.max(expectedScore, 0), 1) * 1000) / 1000;

    assert.equal(result.score, expectedScore);
  });

  it('computes post-compaction drift signal', () => {
    // 2 tool calls before compaction, 3 after → drift = 3/5 = 0.6
    const snapshots = [
      snap(50, false, '2024-01-01T00:01:00Z'),
      snap(50, false, '2024-01-01T00:02:00Z'),
      snap(30, true, '2024-01-01T00:03:00Z'),  // compaction
      snap(40, false, '2024-01-01T00:04:00Z'),
      snap(50, false, '2024-01-01T00:05:00Z'),
    ];

    const events = [
      toolCallEvent({ timestamp: '2024-01-01T00:01:00Z' }),
      toolCallEvent({ timestamp: '2024-01-01T00:02:00Z' }),
      toolCallEvent({ timestamp: '2024-01-01T00:03:30Z' }),
      toolCallEvent({ timestamp: '2024-01-01T00:04:00Z' }),
      toolCallEvent({ timestamp: '2024-01-01T00:05:00Z' }),
    ];

    const result = computeRiskAssessment({
      snapshots,
      events,
      model: null,
      compactionCount: 1,
      subagentCount: 0,
    });

    const driftSignal = result.signals.find((s) => s.name === 'post_compaction_drift');
    assert.ok(driftSignal);
    assert.equal(driftSignal.value, 0.6);
  });

  it('counts long tool outputs', () => {
    const longOutput = 'x'.repeat(50_000);
    const events = [
      toolCallEvent({ event_type: 'tool_call_end', output_data: longOutput }),
      toolCallEvent({ event_type: 'tool_call_end', output_data: longOutput }),
      toolCallEvent({ event_type: 'tool_call_end', output_data: 'short' }),
    ];

    const result = computeRiskAssessment({
      snapshots: [snap(20)],
      events,
      model: null,
      compactionCount: 0,
      subagentCount: 0,
    });

    const longSignal = result.signals.find((s) => s.name === 'long_tool_output');
    assert.ok(longSignal);
    assert.equal(longSignal.value, 0.4); // 2/5
  });

  it('caps deep nesting signal at 3 subagents', () => {
    const result = computeRiskAssessment({
      snapshots: [snap(20)],
      events: [],
      model: null,
      compactionCount: 0,
      subagentCount: 4,
    });

    const nestSignal = result.signals.find((s) => s.name === 'deep_nesting');
    assert.ok(nestSignal);
    assert.equal(nestSignal.value, 1.0);
  });
});
