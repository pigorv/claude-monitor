import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeContextPressure } from '../../src/analysis/context-pressure.js';
import type { TokenSnapshot } from '../../src/ingestion/token-tracker.js';

// ── Helper ──────────────────────────────────────────────────────────

function snap(context_pct: number, is_compaction = false): TokenSnapshot {
  return {
    timestamp: new Date().toISOString(),
    input_tokens: 100_000,
    output_tokens: 1_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    context_pct,
    is_compaction,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('computeContextPressure', () => {
  it('returns zero scores for empty snapshots', () => {
    const result = computeContextPressure([], null);
    assert.equal(result.peakContextPct, 0);
    assert.equal(result.avgContextPct, 0);
    assert.equal(result.timeInWarningZone, 0);
    assert.equal(result.timeInDangerZone, 0);
    assert.equal(result.contextUtilizationScore, 0);
  });

  it('returns score = 0 when all below warning threshold', () => {
    // Sonnet warning = 65%
    const snapshots = [snap(30), snap(40), snap(50)];
    const result = computeContextPressure(snapshots, 'claude-sonnet-4-5');
    assert.equal(result.contextUtilizationScore, 0);
    assert.equal(result.timeInWarningZone, 0);
    assert.equal(result.timeInDangerZone, 0);
  });

  it('returns score near 1.0 when peak near 100%', () => {
    // Sonnet warning = 65%, so score = (99 - 65) / (100 - 65) ≈ 0.971
    const snapshots = [snap(50), snap(80), snap(99)];
    const result = computeContextPressure(snapshots, 'claude-sonnet-4-5');
    assert.ok(result.contextUtilizationScore > 0.9, `Expected > 0.9, got ${result.contextUtilizationScore}`);
    assert.ok(result.contextUtilizationScore <= 1.0);
  });

  it('computes correct zone fractions', () => {
    // Sonnet: warning=65%, danger=75%
    // 4 snapshots: 50 (below), 70 (warning), 80 (danger), 90 (danger)
    const snapshots = [snap(50), snap(70), snap(80), snap(90)];
    const result = computeContextPressure(snapshots, 'claude-sonnet-4-5');

    // Warning zone: 70, 80, 90 = 3/4
    assert.equal(result.timeInWarningZone, 0.75);
    // Danger zone: 80, 90 = 2/4
    assert.equal(result.timeInDangerZone, 0.5);
  });

  it('uses different thresholds for different models', () => {
    // Opus warning=60%, Haiku warning=70%
    const snapshots = [snap(65)];

    const opusResult = computeContextPressure(snapshots, 'claude-opus-4-5');
    const haikuResult = computeContextPressure(snapshots, 'claude-haiku-4-5');

    // 65% is above opus warning (60%) but below haiku warning (70%)
    assert.ok(opusResult.contextUtilizationScore > 0, 'Opus should have non-zero score');
    assert.equal(haikuResult.contextUtilizationScore, 0, 'Haiku should have zero score');
  });

  it('computes correct peak and average', () => {
    const snapshots = [snap(20), snap(40), snap(60)];
    const result = computeContextPressure(snapshots, null);
    assert.equal(result.peakContextPct, 60);
    assert.equal(result.avgContextPct, 40);
  });
});
