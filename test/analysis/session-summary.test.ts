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

  // ── Slash command title extraction ─────────────────────────────────

  const baseInput = {
    model: null,
    durationMs: null,
    toolCallCount: 0,
    topTools: [] as string[],
    compactionCount: 0,
    subagentCount: 0,
    peakContextPct: null,
    riskLevel: 'low' as const,
  };

  it('uses command name when slash command has empty args', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: '<command-name>/commit</command-name><command-message>Skill prompt...</command-message><command-args></command-args>',
    });
    assert.equal(summary, '/commit');
  });

  it('shows command name with args when slash command has arguments', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: '<command-name>/commit</command-name><command-message>Skill prompt...</command-message><command-args>-m "fix bug"</command-args>',
    });
    assert.equal(summary, '/commit — -m "fix bug"');
  });

  it('shows command name with numeric args', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: '<command-name>/review-pr</command-name><command-message>Review prompt...</command-message><command-args>123</command-args>',
    });
    assert.equal(summary, '/review-pr — 123');
  });

  it('truncates long command args', () => {
    const longArgs = 'a very long argument string that '.repeat(5);
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: `<command-name>/commit</command-name><command-args>${longArgs}</command-args>`,
    });
    assert.ok(summary.startsWith('/commit — '), `Expected to start with "/commit — ", got: ${summary}`);
    assert.ok(summary.length <= 115, `Expected <= 115 chars, got ${summary.length}: ${summary}`);
    assert.ok(summary.endsWith('…'), `Expected truncation ellipsis, got: ${summary}`);
  });

  it('uses command name alone when no args and matching skill name', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: '<command-name>/commit</command-name><command-message>Base directory for this skill: /home/user/.claude/skills/commit\nSkill prompt...</command-message>',
    });
    assert.equal(summary, '/commit');
  });

  it('shows skill name when it differs from command name', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: '<command-name>/my-cmd</command-name><command-message>Base directory for this skill: /home/user/.claude/skills/review-helper\nSkill prompt...</command-message>',
    });
    assert.equal(summary, '/my-cmd (review-helper)');
  });

  it('extracts skill name for skill expansion without command-name', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: 'Base directory for this skill: /home/user/.claude/skills/simplify\nARGUMENTS: none',
    });
    assert.equal(summary, 'simplify');
  });

  it('preserves regular text messages unchanged', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: 'Fix the authentication bug in login.ts',
    });
    assert.equal(summary, 'Fix the authentication bug in login.ts');
  });

  it('returns Session for empty message after stripping', () => {
    const summary = generateSessionSummary({
      ...baseInput,
      firstUserMessage: '<system-reminder>some reminder</system-reminder>',
    });
    assert.equal(summary, 'Session');
  });
});
