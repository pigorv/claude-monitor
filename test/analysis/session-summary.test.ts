import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { generateSessionSummary } from '../../src/analysis/session-summary.js';

describe('generateSessionSummary', () => {
  it('extracts model name from full model string', () => {
    const summary = generateSessionSummary({
      model: 'claude-opus-4-5-20250414',
      durationMs: 60_000,
      toolCallCount: 10,
      topTools: ['Read', 'Edit'],
      compactionCount: 0,
      subagentCount: 0,
      peakContextPct: 40,
      riskLevel: 'low',
    });

    assert.ok(summary.startsWith('Opus session'), `Expected to start with "Opus session", got: ${summary}`);
  });

  it('formats duration correctly', () => {
    const summary = generateSessionSummary({
      model: 'claude-sonnet-4-5',
      durationMs: 3_723_000, // 1h 2m 3s
      toolCallCount: 5,
      topTools: [],
      compactionCount: 0,
      subagentCount: 0,
      peakContextPct: null,
      riskLevel: 'low',
    });

    assert.ok(summary.includes('1h 2m'), `Expected duration "1h 2m", got: ${summary}`);
  });

  it('includes compaction count when > 0', () => {
    const summary = generateSessionSummary({
      model: null,
      durationMs: null,
      toolCallCount: 0,
      topTools: [],
      compactionCount: 2,
      subagentCount: 0,
      peakContextPct: null,
      riskLevel: 'medium',
    });

    assert.ok(summary.includes('2 compactions'), `Expected compaction info, got: ${summary}`);
  });

  it('omits compaction when 0', () => {
    const summary = generateSessionSummary({
      model: null,
      durationMs: null,
      toolCallCount: 0,
      topTools: [],
      compactionCount: 0,
      subagentCount: 0,
      peakContextPct: null,
      riskLevel: 'low',
    });

    assert.ok(!summary.includes('compaction'), `Should not mention compactions, got: ${summary}`);
  });

  it('includes subagent count when > 0', () => {
    const summary = generateSessionSummary({
      model: null,
      durationMs: null,
      toolCallCount: 0,
      topTools: [],
      compactionCount: 0,
      subagentCount: 3,
      peakContextPct: null,
      riskLevel: 'high',
    });

    assert.ok(summary.includes('3 subagents'), `Expected subagent info, got: ${summary}`);
  });

  it('includes risk level', () => {
    const summary = generateSessionSummary({
      model: 'claude-haiku-4-5',
      durationMs: 30_000,
      toolCallCount: 20,
      topTools: ['Read', 'Bash', 'Edit'],
      compactionCount: 1,
      subagentCount: 0,
      peakContextPct: 82,
      riskLevel: 'critical',
    });

    assert.ok(summary.includes('Critical risk'), `Expected risk level, got: ${summary}`);
  });

  it('handles unknown model gracefully', () => {
    const summary = generateSessionSummary({
      model: null,
      durationMs: null,
      toolCallCount: 0,
      topTools: [],
      compactionCount: 0,
      subagentCount: 0,
      peakContextPct: null,
      riskLevel: 'low',
    });

    assert.ok(summary.startsWith('Unknown session'), `Expected "Unknown session", got: ${summary}`);
  });

  it('truncates to 150 chars', () => {
    const summary = generateSessionSummary({
      model: 'claude-sonnet-4-5',
      durationMs: 7_200_000,
      toolCallCount: 500,
      topTools: ['Read', 'Write', 'Bash'],
      compactionCount: 5,
      subagentCount: 10,
      peakContextPct: 99.5,
      riskLevel: 'critical',
    });

    assert.ok(summary.length <= 150, `Expected <= 150 chars, got ${summary.length}: ${summary}`);
  });
});
