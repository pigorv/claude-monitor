import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { fcParams, transcriptArb } from '../helpers/property.js';
import {
  buildTokenSnapshots,
  computeAggregates,
  resolveThreshold,
  type TokenSnapshot,
} from '../../src/ingestion/token-tracker.js';
import { contextWindowFor } from '../../src/shared/cost.js';

// Effective context of a snapshot = the three context-window components the
// source sums (input + cache_read + cache_write). Both buildTokenSnapshots and
// computeAggregates key their compaction / max-context logic off this value.
function effective(s: TokenSnapshot): number {
  return s.input_tokens + s.cache_read_tokens + s.cache_write_tokens;
}

// ── Behavior #1 — non-negativity ───────────────────────────────────

describe('token-tracker properties — Behavior #1 (non-negativity)', () => {
  it('every snapshot field and every aggregate total is >= 0', () => {
    fc.assert(
      fc.property(transcriptArb, (msgs) => {
        const snapshots = buildTokenSnapshots(msgs);
        for (const s of snapshots) {
          assert.ok(s.input_tokens >= 0);
          assert.ok(s.output_tokens >= 0);
          assert.ok(s.cache_read_tokens >= 0);
          assert.ok(s.cache_write_tokens >= 0);
          assert.ok(s.cache_write_5m_tokens >= 0);
          assert.ok(s.cache_write_1h_tokens >= 0);
          assert.ok(s.context_pct >= 0);
        }
        const agg = computeAggregates(snapshots);
        assert.ok(agg.total_input_tokens >= 0);
        assert.ok(agg.total_output_tokens >= 0);
        assert.ok(agg.total_cache_read_tokens >= 0);
        assert.ok(agg.total_cache_write_tokens >= 0);
        assert.ok(agg.total_input_tokens_billed >= 0);
        assert.ok(agg.total_cache_write_5m_tokens >= 0);
        assert.ok(agg.total_cache_write_1h_tokens >= 0);
        assert.ok(agg.peak_context_pct >= 0);
        assert.ok(agg.compaction_count >= 0);
      }),
      fcParams(),
    );
  });
});

// ── Behavior #2 — context_pct is finite, non-negative, and overflow
//    (> 100) implies effective context exceeds the model window ───────

describe('token-tracker properties — Behavior #2 (context_pct)', () => {
  it('context_pct >= 0, finite, and > 100 only when effective > model window', () => {
    fc.assert(
      fc.property(
        transcriptArb,
        fc.constantFrom('claude-sonnet-4-6', 'claude-opus-4-6', null),
        (msgs, model) => {
          // Passing an explicit model overrides per-message model, so every
          // snapshot shares this one known model and window.
          const snapshots = buildTokenSnapshots(msgs, model);
          const window = contextWindowFor(model) ?? resolveThreshold(model).maxTokens;
          for (const s of snapshots) {
            assert.ok(s.context_pct >= 0 && Number.isFinite(s.context_pct));
            if (s.context_pct > 100) {
              assert.ok(effective(s) > window);
            }
          }
        },
      ),
      fcParams(),
    );
  });
});

// ── Behavior #3 — order preservation & snapshot count bound ─────────

describe('token-tracker properties — Behavior #3 (ordering)', () => {
  it('emits <= surviving assistant-with-usage messages and non-decreasing timestamps', () => {
    fc.assert(
      fc.property(transcriptArb, (msgs) => {
        const snapshots = buildTokenSnapshots(msgs);
        const candidates = msgs.filter((m) => m.type === 'assistant' && m.usage).length;
        // Zero-token messages are additionally skipped, so it is <=, not ===.
        assert.ok(snapshots.length <= candidates);
        for (let i = 1; i < snapshots.length; i++) {
          assert.ok(
            Date.parse(snapshots[i - 1].timestamp) <= Date.parse(snapshots[i].timestamp),
          );
          // ISO string ordering agrees with chronological ordering here.
          assert.ok(snapshots[i - 1].timestamp <= snapshots[i].timestamp);
        }
      }),
      fcParams(),
    );
  });
});

// ── Behavior #4 — aggregate reconciliation ─────────────────────────

describe('token-tracker properties — Behavior #4 (reconciliation)', () => {
  it('aggregate totals equal element-wise snapshot sums; input total = max effective', () => {
    fc.assert(
      fc.property(transcriptArb, (msgs) => {
        const snapshots = buildTokenSnapshots(msgs);
        const agg = computeAggregates(snapshots);

        const expectedOutput = snapshots.reduce((n, s) => n + s.output_tokens, 0);
        const expectedCacheRead = snapshots.reduce((n, s) => n + s.cache_read_tokens, 0);
        const expectedCacheWrite = snapshots.reduce((n, s) => n + s.cache_write_tokens, 0);
        const expectedBilled = snapshots.reduce((n, s) => n + s.input_tokens, 0);
        const expected5m = snapshots.reduce((n, s) => n + s.cache_write_5m_tokens, 0);
        const expected1h = snapshots.reduce((n, s) => n + s.cache_write_1h_tokens, 0);
        const expectedMaxEffective = Math.max(0, ...snapshots.map(effective));
        const expectedPeakPct =
          Math.round(Math.max(0, ...snapshots.map((s) => s.context_pct)) * 100) / 100;

        assert.equal(agg.total_output_tokens, expectedOutput);
        assert.equal(agg.total_cache_read_tokens, expectedCacheRead);
        assert.equal(agg.total_cache_write_tokens, expectedCacheWrite);
        assert.equal(agg.total_input_tokens_billed, expectedBilled);
        assert.equal(agg.total_cache_write_5m_tokens, expected5m);
        assert.equal(agg.total_cache_write_1h_tokens, expected1h);
        assert.equal(agg.total_input_tokens, expectedMaxEffective);
        assert.equal(agg.peak_context_pct, expectedPeakPct);
      }),
      fcParams(),
    );
  });
});

// ── Behavior #5 — compaction accounting ────────────────────────────

describe('token-tracker properties — Behavior #5 (compaction)', () => {
  it('compaction_count matches flagged snapshots, each a >30% effective-context drop', () => {
    fc.assert(
      fc.property(transcriptArb, (msgs) => {
        const snapshots = buildTokenSnapshots(msgs);
        const agg = computeAggregates(snapshots);

        assert.equal(
          agg.compaction_count,
          snapshots.filter((s) => s.is_compaction).length,
        );

        for (let k = 0; k < snapshots.length; k++) {
          if (!snapshots[k].is_compaction) continue;
          // A flagged snapshot always has a true predecessor (consecutive
          // snapshots are consecutive non-skipped messages).
          assert.ok(k >= 1);
          const effPrev = effective(snapshots[k - 1]);
          const effK = effective(snapshots[k]);
          assert.ok(effPrev > 0);
          assert.ok(effK < effPrev * 0.7);
        }
      }),
      fcParams(),
    );
  });
});
