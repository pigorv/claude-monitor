import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { computeRiskAssessment, riskLevel } from '../../src/analysis/risk-scoring.js';
import { computeContextPressure } from '../../src/analysis/context-pressure.js';
import { generateSessionSummary } from '../../src/analysis/session-summary.js';
import { importTranscript } from '../../src/ingestion/transcript-importer.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { getSession } from '../../src/db/queries/sessions.js';
import { listEventsBySession, getTokenTimeline } from '../../src/db/queries/events.js';
import type { TokenSnapshot } from '../../src/ingestion/token-tracker.js';
import type { ParsedEvent } from '../../src/ingestion/thinking-extractor.js';

// ── Analysis boundary tests ──────────────────────────────────────────

describe('Risk scoring boundary conditions', () => {
  it('returns exactly 0 for completely safe session', () => {
    const result = computeRiskAssessment({
      snapshots: [],
      events: [],
      model: null,
      compactionCount: 0,
      subagentCount: 0,
    });
    assert.equal(result.score, 0);
    assert.equal(result.level, 'low');
  });

  it('never exceeds 1.0 even with all signals maxed', () => {
    const snap = (pct: number, isComp = false): TokenSnapshot => ({
      timestamp: '2024-01-01T00:00:00Z',
      input_tokens: 200_000,
      output_tokens: 10_000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      context_pct: pct,
      is_compaction: isComp,
    });

    const longOutput = 'x'.repeat(100_000);
    const events: ParsedEvent[] = Array.from({ length: 20 }, (_, i) => ({
      event_type: 'tool_call_end' as const,
      timestamp: `2024-01-01T00:${String(i).padStart(2, '0')}:00Z`,
      tool_name: 'Bash',
      input_preview: null,
      input_data: null,
      output_preview: null,
      output_data: longOutput,
      thinking_summary: null,
      thinking_text: null,
    }));

    const result = computeRiskAssessment({
      snapshots: [snap(99), snap(30, true), snap(99), snap(30, true), snap(99)],
      events,
      model: 'claude-sonnet-4-5',
      compactionCount: 10,
      subagentCount: 10,
    });

    assert.ok(result.score <= 1.0, `Score ${result.score} exceeds 1.0`);
    assert.ok(result.score >= 0, `Score ${result.score} is negative`);
    // With all signals elevated, should be at least 'high' risk
    assert.ok(
      result.level === 'high' || result.level === 'critical',
      `Expected high or critical, got ${result.level} (score: ${result.score})`,
    );
  });

  it('risk level boundaries are exact', () => {
    assert.equal(riskLevel(0.0), 'low');
    assert.equal(riskLevel(0.299), 'low');
    assert.equal(riskLevel(0.3), 'medium');
    assert.equal(riskLevel(0.599), 'medium');
    assert.equal(riskLevel(0.6), 'high');
    assert.equal(riskLevel(0.799), 'high');
    assert.equal(riskLevel(0.8), 'critical');
    assert.equal(riskLevel(1.0), 'critical');
  });
});

describe('Context pressure with all model types', () => {
  function snap(pct: number): TokenSnapshot {
    return {
      timestamp: '2024-01-01T00:00:00Z',
      input_tokens: Math.round(pct * 2000),
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      context_pct: pct,
      is_compaction: false,
    };
  }

  it('opus has lowest warning threshold (60%)', () => {
    const result = computeContextPressure([snap(62)], 'claude-opus-4-6');
    assert.ok(result.contextUtilizationScore > 0, 'Opus at 62% should be above warning');
  });

  it('sonnet warning at 65%', () => {
    const below = computeContextPressure([snap(63)], 'claude-sonnet-4-5');
    const above = computeContextPressure([snap(67)], 'claude-sonnet-4-5');
    assert.equal(below.contextUtilizationScore, 0);
    assert.ok(above.contextUtilizationScore > 0);
  });

  it('haiku warning at 70%', () => {
    const below = computeContextPressure([snap(68)], 'claude-haiku-4-5');
    const above = computeContextPressure([snap(72)], 'claude-haiku-4-5');
    assert.equal(below.contextUtilizationScore, 0);
    assert.ok(above.contextUtilizationScore > 0);
  });

  it('unknown model falls back to sonnet thresholds', () => {
    const sonnetResult = computeContextPressure([snap(67)], 'claude-sonnet-4-5');
    const unknownResult = computeContextPressure([snap(67)], 'unknown-model-3000');
    assert.equal(sonnetResult.contextUtilizationScore, unknownResult.contextUtilizationScore);
  });
});

// ── End-to-end analysis integration ──────────────────────────────────

describe('Analysis engine end-to-end', () => {
  const TEST_DIR = join(tmpdir(), `analysis-e2e-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(join(TEST_DIR, 'test.sqlite'));
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imported session has risk_score populated in DB', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/p', sessionId: 'e2e-risk', type: 'user',
        message: { role: 'user', content: 'do task' },
        timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
      }),
      JSON.stringify({
        parentUuid: 'u1', cwd: '/tmp/p', sessionId: 'e2e-risk', type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5', role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this task carefully.' },
            { type: 'text', text: 'Done.' },
          ],
          usage: { input_tokens: 2000, output_tokens: 100 },
        },
        timestamp: '2026-01-01T00:00:10.000Z', uuid: 'a1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'e2e.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('e2e-risk');
    assert.ok(session);
    assert.equal(typeof session.risk_score, 'number');
    assert.ok(session.risk_score! >= 0);
    assert.ok(session.risk_score! <= 1);
    assert.ok(session.summary);

    // Verify metadata contains risk_signals
    if (session.metadata) {
      const meta = JSON.parse(session.metadata);
      assert.ok(Array.isArray(meta.risk_signals));
      assert.ok(meta.risk_signals.length > 0);
    }
  });

  it('high-utilization session gets higher risk score', async () => {
    // Session with high token usage (near context limit)
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/p', sessionId: 'high-util', type: 'user',
        message: { role: 'user', content: 'big task' },
        timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
      }),
      JSON.stringify({
        parentUuid: 'u1', cwd: '/tmp/p', sessionId: 'high-util', type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5', role: 'assistant',
          content: [{ type: 'text', text: 'Working...' }],
          usage: { input_tokens: 180000, output_tokens: 5000 },
        },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'a1',
      }),
    ].join('\n');

    const lowJsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/p', sessionId: 'low-util', type: 'user',
        message: { role: 'user', content: 'small task' },
        timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
      }),
      JSON.stringify({
        parentUuid: 'u1', cwd: '/tmp/p', sessionId: 'low-util', type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5', role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
        timestamp: '2026-01-01T00:00:05.000Z', uuid: 'a1',
      }),
    ].join('\n');

    writeFileSync(join(TEST_DIR, 'high.jsonl'), jsonl);
    writeFileSync(join(TEST_DIR, 'low.jsonl'), lowJsonl);

    await importTranscript(join(TEST_DIR, 'high.jsonl'));
    await importTranscript(join(TEST_DIR, 'low.jsonl'));

    const highSession = getSession('high-util');
    const lowSession = getSession('low-util');
    assert.ok(highSession);
    assert.ok(lowSession);
    assert.ok(
      highSession.risk_score! > lowSession.risk_score!,
      `High util risk (${highSession.risk_score}) should exceed low util risk (${lowSession.risk_score})`,
    );
  });
});
