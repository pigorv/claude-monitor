import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { fcParams, sessionAndAgentTimelineArb, transcriptArb } from '../helpers/property.js';
import { computeAgentEfficiency } from '../../src/analysis/agent-efficiency.js';
import { buildTokenSnapshots, computeAggregates } from '../../src/ingestion/token-tracker.js';
import type { TokenDataPoint } from '../../src/shared/types.js';

// Effective context of a timeline point = the three components the function
// under test sums when tracking peak context (input + cache_read + cache_write).
function effective(p: TokenDataPoint): number {
  return p.input_tokens + p.cache_read_tokens + p.cache_write_tokens;
}

// ── Behavior #6 — child peak <= session peak ───────────────────────

describe('agent-efficiency properties — Behavior #6 (child peak <= session peak)', () => {
  it('computeAgentEfficiency peak_context_tokens <= session peak effective context', () => {
    fc.assert(
      fc.property(sessionAndAgentTimelineArb, ({ session, agent }) => {
        // Session peak effective context (0 when the session is empty), using
        // the same effective formula the function under test applies.
        const sessionPeak = session.length === 0 ? 0 : Math.max(...session.map(effective));

        const agentPeak = computeAgentEfficiency(null, null, agent, null, null)
          .peak_context_tokens;

        if (agentPeak === null) {
          // Empty agent timeline → invariant trivially satisfied.
          return;
        }
        // agent is a subarray of session, so its max effective context cannot
        // exceed the session's.
        assert.ok(agentPeak <= sessionPeak);
      }),
      fcParams(),
    );
  });
});

// ── Behavior #7 — the harness bites (deliberately-broken invariant) ─

describe('agent-efficiency properties — Behavior #7 (sanity check)', () => {
  // This test asserts that a KNOWINGLY-FALSE property is CAUGHT by fast-check.
  // A green run therefore proves the harness would flag a real regression rather
  // than passing vacuously: fast-check must report a counterexample.
  it('fast-check catches a deliberately-broken reconciliation invariant', () => {
    const brokenProperty = fc.property(transcriptArb, (msgs) => {
      const snaps = buildTokenSnapshots(msgs);
      const agg = computeAggregates(snaps);
      const trueOutputSum = snaps.reduce((a, s) => a + s.output_tokens, 0);
      // BROKEN on purpose: claims the aggregate output equals the true sum PLUS
      // ONE, which is false for every input (including the empty transcript).
      return agg.total_output_tokens === trueOutputSum + 1;
    });

    const result = fc.check(brokenProperty, fcParams());
    // fast-check DID catch the broken invariant.
    assert.equal(result.failed, true);
    assert.ok(result.counterexample != null);
  });
});
