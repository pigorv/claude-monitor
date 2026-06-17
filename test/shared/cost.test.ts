import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  costBreakdown,
  resolveModel,
  contextWindowFor,
  pricingFor,
  sessionCostUsd,
  type CostParts,
} from '../../src/shared/cost.js';

function approx(actual: number, expected: number, msg?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} expected ${expected}, got ${actual}`);
}

// rate ($/MTok) tables matching models.json
const RATES = {
  'claude-opus-4-8': {
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_write_5m: 6.25,
    cache_write_1h: 10.0,
    cache_write_default: 6.25,
  },
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cache_read: 0.3,
    cache_write_5m: 3.75,
    cache_write_1h: 6.0,
    cache_write_default: 3.75,
  },
  'claude-haiku-4-5': {
    input: 1,
    output: 5,
    cache_read: 0.1,
    cache_write_5m: 1.25,
    cache_write_1h: 2.0,
    cache_write_default: 1.25,
  },
  'claude-fable-5': {
    input: 10,
    output: 50,
    cache_read: 1.0,
    cache_write_5m: 12.5,
    cache_write_1h: 20.0,
    cache_write_default: 12.5,
  },
};

const PARTS: CostParts = {
  freshInput: 123_456,
  cacheRead: 987_654,
  cacheWrite5m: 54_321,
  cacheWrite1h: 67_890,
  cacheWriteDefault: 0,
  output: 45_678,
};

function expectedPerType(rates: (typeof RATES)['claude-opus-4-8'], parts: CostParts) {
  const r6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;
  return {
    freshInput: r6((parts.freshInput / 1e6) * rates.input),
    cacheRead: r6((parts.cacheRead / 1e6) * rates.cache_read),
    cacheWrite5m: r6((parts.cacheWrite5m / 1e6) * rates.cache_write_5m),
    cacheWrite1h: r6((parts.cacheWrite1h / 1e6) * rates.cache_write_1h),
    cacheWriteDefault: r6(((parts.cacheWriteDefault ?? 0) / 1e6) * rates.cache_write_default),
    output: r6((parts.output / 1e6) * rates.output),
  };
}

describe('costBreakdown', () => {
  for (const model of Object.keys(RATES) as Array<keyof typeof RATES>) {
    it(`${model}: per-type rates and total == sum(perType)`, () => {
      const result = costBreakdown(model, PARTS);
      assert.ok(result, `expected a breakdown for ${model}`);

      const rates = RATES[model];
      const exp = expectedPerType(rates, PARTS);

      // Behavior #2: each per-type value matches hand-computed rate
      approx(result.perType.freshInput, exp.freshInput, 'freshInput');
      approx(result.perType.cacheRead, exp.cacheRead, 'cacheRead');
      approx(result.perType.cacheWrite5m, exp.cacheWrite5m, 'cacheWrite5m');
      approx(result.perType.cacheWrite1h, exp.cacheWrite1h, 'cacheWrite1h');
      approx(result.perType.cacheWriteDefault, exp.cacheWriteDefault, 'cacheWriteDefault');
      approx(result.perType.output, exp.output, 'output');

      // Behavior #1: total == sum of perType
      const sum =
        result.perType.freshInput +
        result.perType.cacheRead +
        result.perType.cacheWrite5m +
        result.perType.cacheWrite1h +
        result.perType.cacheWriteDefault +
        result.perType.output;
      approx(result.total, sum, 'total');
    });
  }

  it('residual-only cache write is priced at cache_write_default (Behavior #5)', () => {
    const parts: CostParts = {
      freshInput: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteDefault: 200_000,
      output: 0,
    };
    const result = costBreakdown('claude-opus-4-8', parts);
    assert.ok(result);
    const expected = Math.round(((200_000 / 1e6) * 6.25) * 1_000_000) / 1_000_000;
    approx(result.perType.cacheWriteDefault, expected, 'cacheWriteDefault');
    approx(result.perType.cacheWrite5m, 0, '5m');
    approx(result.perType.cacheWrite1h, 0, '1h');
    approx(result.total, expected, 'total == residual cost');
  });

  it('cacheWriteDefault defaults to 0 when omitted', () => {
    const parts = {
      freshInput: 1000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
    };
    const result = costBreakdown('claude-opus-4-8', parts);
    assert.ok(result);
    approx(result.perType.cacheWriteDefault, 0, 'defaulted to 0');
  });

  it('unknown model returns undefined (Behavior #8)', () => {
    assert.equal(costBreakdown('totally-unknown-model', PARTS), undefined);
  });
});

describe('resolveModel', () => {
  it('matches dated suffix to full-ID entry', () => {
    const r = resolveModel('claude-opus-4-5-20251101');
    assert.ok(r);
    assert.equal(r.id, 'claude-opus-4-5');
    assert.equal(r.pricing.input, 5);
    assert.equal(r.context_window, 1000000);
  });

  it('unknown version of known family falls back to family rep (Behavior #8)', () => {
    const r = resolveModel('claude-opus-4-99');
    assert.ok(r);
    assert.equal(r.id, 'claude-opus-4-8');
    assert.equal(r.pricing.input, 5);
    assert.equal(r.pricing.output, 25);
    assert.equal(r.context_window, 1000000);
  });

  it('fully unknown model returns null (Behavior #8)', () => {
    assert.equal(resolveModel('totally-unknown-model'), null);
    assert.equal(resolveModel(null), null);
    assert.equal(resolveModel(undefined), null);
  });
});

describe('sessionCostUsd', () => {
  it('sums parent + per-agent at each own model, incl. cache + sub-agent (Behavior #3, #4)', () => {
    const parent = {
      freshInput: 200_000,
      cacheRead: 1_500_000,
      cacheWrite5m: 80_000,
      cacheWrite1h: 40_000,
      cacheWriteDefault: 25_000,
      output: 90_000,
    };
    const agent = {
      model: 'claude-haiku-4-5' as string | null,
      freshInput: 50_000,
      cacheRead: 300_000,
      cacheWrite5m: 10_000,
      cacheWrite1h: 5_000,
      output: 20_000,
    };

    const result = sessionCostUsd('claude-opus-4-8', parent, [agent]);
    assert.ok(result !== null, 'expected a non-null cost');

    // Hand-computed: parent at opus + agent at haiku (its own, different model)
    const parentBd = costBreakdown('claude-opus-4-8', parent);
    const agentBd = costBreakdown('claude-haiku-4-5', {
      freshInput: agent.freshInput,
      cacheRead: agent.cacheRead,
      cacheWrite5m: agent.cacheWrite5m,
      cacheWrite1h: agent.cacheWrite1h,
      cacheWriteDefault: 0,
      output: agent.output,
    });
    assert.ok(parentBd && agentBd);
    const expected = Math.round((parentBd.total + agentBd.total) * 1_000_000) / 1_000_000;
    approx(result, expected, 'parent + agent total');

    // Behavior #3: strictly greater than an input+output-only estimate
    const inputOutputOnly = sessionCostUsd(
      'claude-opus-4-8',
      { ...parent, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteDefault: 0 },
      [{ ...agent, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }],
    );
    assert.ok(inputOutputOnly !== null);
    assert.ok(result > inputOutputOnly, `expected ${result} > ${inputOutputOnly}`);
  });

  it('agent with null model is priced at the parent model (Behavior #4 fallback)', () => {
    const parent = {
      freshInput: 0,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteDefault: 0,
      output: 0,
    };
    const agent = {
      model: null as string | null,
      freshInput: 100_000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
    };

    const result = sessionCostUsd('claude-opus-4-8', parent, [agent]);
    assert.ok(result !== null);

    const atParent = costBreakdown('claude-opus-4-8', {
      freshInput: agent.freshInput,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteDefault: 0,
      output: 0,
    });
    assert.ok(atParent);
    approx(result, atParent.total, 'agent priced at parent model');

    // Sanity: priced at opus (5/MTok), not e.g. haiku (1/MTok)
    approx(result, (100_000 / 1e6) * 5, 'opus input rate');
  });

  it('unresolvable parent model with no agents returns null (Behavior #8)', () => {
    const result = sessionCostUsd(
      'totally-unknown-model',
      {
        freshInput: 100_000,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheWriteDefault: 0,
        output: 50_000,
      },
      [],
    );
    assert.equal(result, null);
  });
});

describe('contextWindowFor / pricingFor', () => {
  it('returns window and pricing for known model', () => {
    assert.equal(contextWindowFor('claude-sonnet-4-6'), 200000);
    assert.equal(pricingFor('claude-haiku-4-5')?.input, 1);
  });

  it('returns null for unknown model', () => {
    assert.equal(contextWindowFor('totally-unknown-model'), null);
    assert.equal(pricingFor('totally-unknown-model'), null);
  });
});
