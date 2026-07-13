import { describe, it, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import {
  costBreakdown,
  resolveModel,
  contextWindowFor,
  pricingFor,
  sessionCostUsd,
  setDiscountRules,
  getDiscountRules,
  discountMultiplier,
  MODEL_IDS,
  type CostParts,
  type DiscountRule,
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

  it('resolves claude-sonnet-5 to its own 1M entry (Behavior #1)', () => {
    const r = resolveModel('claude-sonnet-5');
    assert.ok(r);
    assert.equal(r.id, 'claude-sonnet-5');
    assert.equal(r.context_window, 1_000_000);
    assert.equal(r.pricing.input, 3);
    assert.equal(r.pricing.output, 15);
  });

  it('matches a dated Sonnet 5 suffix to the sonnet-5 entry, not the family fallback (Behavior #3)', () => {
    const r = resolveModel('claude-sonnet-5-20260115');
    assert.ok(r);
    assert.equal(r.id, 'claude-sonnet-5');
    assert.equal(r.context_window, 1_000_000);
  });

  it('unknown version of known family falls back to family rep (Behavior #8)', () => {
    const r = resolveModel('claude-opus-4-99');
    assert.ok(r);
    assert.equal(r.id, 'claude-opus-4-8');
    assert.equal(r.pricing.input, 5);
    assert.equal(r.pricing.output, 25);
    assert.equal(r.context_window, 1000000);
  });

  it('keeps a dated version-1 entry resolving to its own pricing', () => {
    const r = resolveModel('claude-opus-4-1-20250805');
    assert.ok(r);
    assert.equal(r.id, 'claude-opus-4-1');
    assert.equal(r.pricing.input, 15);
    assert.equal(r.pricing.output, 75);
  });

  it('does not let a single-digit key swallow a double-digit version', () => {
    // `claude-opus-4-1` is a substring of `claude-opus-4-10`, but a version
    // boundary must stop it matching — the unknown 4-10 falls back to the
    // opus family rep ($5/$25), not 4-1's pricier $15/$75.
    const r = resolveModel('claude-opus-4-10');
    assert.ok(r);
    assert.equal(r.id, 'claude-opus-4-8');
    assert.equal(r.pricing.input, 5);
    assert.equal(r.pricing.output, 25);
  });

  it('fully unknown model returns null (Behavior #8)', () => {
    assert.equal(resolveModel('totally-unknown-model'), null);
    assert.equal(resolveModel(null), null);
    assert.equal(resolveModel(undefined), null);
  });

  it('[1m] marker overrides context window to 1M but keeps base id + pricing', () => {
    const base = resolveModel('claude-sonnet-4-6');
    assert.ok(base);
    assert.equal(base.context_window, 200_000);

    const oneM = resolveModel('claude-sonnet-4-6[1m]');
    assert.ok(oneM);
    assert.equal(oneM.context_window, 1_000_000);
    // id and pricing match the base entry, untouched by the marker
    assert.equal(oneM.id, base.id);
    assert.deepEqual(oneM.pricing, base.pricing);
  });

  it('[1m] marker works through the family fallback too', () => {
    const oneM = resolveModel('claude-sonnet-4-99[1m]');
    assert.ok(oneM);
    assert.equal(oneM.id, 'claude-sonnet-4-6');
    assert.equal(oneM.context_window, 1_000_000);
    assert.equal(oneM.pricing.input, 3);
  });

  it('[1m] marker is Sonnet-scoped — leaves a non-sonnet window untouched', () => {
    const haiku = resolveModel('claude-haiku-4-5[1m]');
    assert.ok(haiku);
    assert.equal(haiku.context_window, 200_000);
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

  it('returns the 1M window and Sonnet 5 pricing for claude-sonnet-5 (Behavior #2)', () => {
    assert.equal(contextWindowFor('claude-sonnet-5'), 1000000);
    assert.equal(pricingFor('claude-sonnet-5')?.input, 3);
  });

  it('returns null for unknown model', () => {
    assert.equal(contextWindowFor('totally-unknown-model'), null);
    assert.equal(pricingFor('totally-unknown-model'), null);
  });
});

describe('discount rules', () => {
  // Discount rules are module-global state; reset after every case so a rule
  // set in one test never leaks into another (or into the list-price tests).
  afterEach(() => setDiscountRules([]));

  const DATE = '2026-07-13T09:30:00.000Z'; // a session started_at

  it('scales costBreakdown / pricingFor / sessionCostUsd by m within the window (Behavior #4)', () => {
    setDiscountRules([
      { model: 'claude-opus-4-8', percentOff: 40, start: '2026-07-01', end: '2026-07-31' },
    ]);
    const m = 0.6;

    // pricingFor: every field is list × m
    const list = RATES['claude-opus-4-8'];
    const priced = pricingFor('claude-opus-4-8', DATE);
    assert.ok(priced);
    approx(priced.input, list.input * m, 'input');
    approx(priced.output, list.output * m, 'output');
    approx(priced.cache_read, list.cache_read * m, 'cache_read');
    approx(priced.cache_write_5m, list.cache_write_5m * m, 'cache_write_5m');
    approx(priced.cache_write_1h, list.cache_write_1h * m, 'cache_write_1h');
    approx(priced.cache_write_default, list.cache_write_default * m, 'cache_write_default');

    // costBreakdown: total scales by m relative to the undiscounted total.
    // (list ref uses no date → the bounded rule doesn't match → list price.)
    const listBd = costBreakdown('claude-opus-4-8', PARTS);
    const discBd = costBreakdown('claude-opus-4-8', PARTS, DATE);
    assert.ok(listBd && discBd);
    approx(discBd.perType.freshInput, listBd.perType.freshInput * m, 'freshInput scaled');
    // per-type values are rounded to 6 decimals, so the scaled total is equal
    // up to a rounding epsilon rather than bit-exact.
    assert.ok(
      Math.abs(discBd.total - listBd.total * m) < 1e-5,
      `total scaled: expected ~${listBd.total * m}, got ${discBd.total}`,
    );

    // sessionCostUsd: parent + agents share the one pricing date
    const parent = {
      freshInput: 200_000,
      cacheRead: 1_500_000,
      cacheWrite5m: 80_000,
      cacheWrite1h: 40_000,
      cacheWriteDefault: 25_000,
      output: 90_000,
    };
    const listCost = sessionCostUsd('claude-opus-4-8', parent, []);
    const discCost = sessionCostUsd('claude-opus-4-8', parent, [], DATE);
    assert.ok(listCost !== null && discCost !== null);
    assert.ok(
      Math.abs(discCost - listCost * m) < 1e-5,
      `session cost scaled: expected ~${listCost * m}, got ${discCost}`,
    );
  });

  it('applies one pricing date to parent and every sub-agent (Behavior #4)', () => {
    setDiscountRules([
      { model: 'claude-opus-4-8', percentOff: 50 },
      { model: 'claude-haiku-4-5', percentOff: 50 },
    ]);
    // undefined date matches the always-on rules above
    const parent = {
      freshInput: 100_000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheWriteDefault: 0,
      output: 0,
    };
    const agent = {
      model: 'claude-haiku-4-5' as string | null,
      freshInput: 100_000,
      cacheRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
    };
    const disc = sessionCostUsd('claude-opus-4-8', parent, [agent]);
    setDiscountRules([]);
    const list = sessionCostUsd('claude-opus-4-8', parent, [agent]);
    assert.ok(disc !== null && list !== null);
    approx(disc, list * 0.5, 'both parent and agent halved');
  });

  it('before / after the window, and unmatched models, pay list price (Behavior #3)', () => {
    setDiscountRules([
      { model: 'claude-opus-4-8', percentOff: 40, start: '2026-07-01', end: '2026-07-31' },
    ]);
    const list = RATES['claude-opus-4-8'];

    // Before window
    assert.equal(discountMultiplier('claude-opus-4-8', '2026-06-30T23:59:59Z'), 1);
    approx(pricingFor('claude-opus-4-8', '2026-06-30')!.input, list.input, 'before');

    // After window
    assert.equal(discountMultiplier('claude-opus-4-8', '2026-08-01T00:00:00Z'), 1);
    approx(pricingFor('claude-opus-4-8', '2026-08-01')!.input, list.input, 'after');

    // A different model — no rule matches
    assert.equal(discountMultiplier('claude-haiku-4-5', DATE), 1);
    approx(pricingFor('claude-haiku-4-5', DATE)!.input, RATES['claude-haiku-4-5'].input, 'other model');

    // Inclusive boundaries hit
    assert.equal(discountMultiplier('claude-opus-4-8', '2026-07-01T00:00:00Z'), 0.6);
    assert.equal(discountMultiplier('claude-opus-4-8', '2026-07-31T23:59:59Z'), 0.6);
  });

  it('honors open-ended start and open-ended end (Behavior #3)', () => {
    setDiscountRules([{ model: 'claude-opus-4-8', percentOff: 20, end: '2026-07-31' }]);
    // no start → any date on or before end matches
    assert.equal(discountMultiplier('claude-opus-4-8', '2000-01-01T00:00:00Z'), 0.8);
    assert.equal(discountMultiplier('claude-opus-4-8', '2026-08-01T00:00:00Z'), 1);

    setDiscountRules([{ model: 'claude-opus-4-8', percentOff: 20, start: '2026-07-01' }]);
    // no end → any date on or after start matches
    assert.equal(discountMultiplier('claude-opus-4-8', '2026-06-30T00:00:00Z'), 1);
    assert.equal(discountMultiplier('claude-opus-4-8', '2999-01-01T00:00:00Z'), 0.8);
  });

  it('undefined date matches only always-on rules (Behavior #3)', () => {
    setDiscountRules([{ model: 'claude-opus-4-8', percentOff: 40, start: '2026-07-01' }]);
    // bounded rule + undefined date → no match → list price
    assert.equal(discountMultiplier('claude-opus-4-8'), 1);

    setDiscountRules([{ model: 'claude-opus-4-8', percentOff: 40 }]);
    // always-on rule + undefined date → matches
    assert.equal(discountMultiplier('claude-opus-4-8'), 0.6);
  });

  it('first matching rule in file order wins on overlap (Behavior #3)', () => {
    setDiscountRules([
      { model: 'claude-opus-4-8', percentOff: 10, start: '2026-07-01', end: '2026-07-31' },
      { model: 'claude-opus-4-8', percentOff: 90, start: '2026-07-10', end: '2026-07-20' },
    ]);
    // DATE (2026-07-13) is in both windows; the first (10% off → ×0.9) wins
    assert.equal(discountMultiplier('claude-opus-4-8', DATE), 0.9);
  });

  it('setDiscountRules drops NaN and out-of-range percentOff (Behavior #9)', () => {
    setDiscountRules([
      { model: 'a', percentOff: Number.NaN },
      { model: 'b', percentOff: -1 },
      { model: 'c', percentOff: 101 },
      { model: 'd', percentOff: Infinity },
      { model: 'claude-opus-4-8', percentOff: 0 }, // valid: 0% is allowed
      { model: 'claude-haiku-4-5', percentOff: 100 }, // valid: 100% is allowed
    ]);
    const kept = getDiscountRules();
    assert.deepEqual(kept.map((r) => r.model), ['claude-opus-4-8', 'claude-haiku-4-5']);
    // 0% off → ×1 (list price), 100% off → ×0 (free)
    assert.equal(discountMultiplier('claude-opus-4-8'), 1);
    assert.equal(discountMultiplier('claude-haiku-4-5'), 0);
  });

  it('getDiscountRules returns a copy, not the live array', () => {
    setDiscountRules([{ model: 'claude-opus-4-8', percentOff: 50 }]);
    const copy = getDiscountRules();
    copy.push({ model: 'claude-haiku-4-5', percentOff: 50 });
    assert.equal(getDiscountRules().length, 1, 'mutating the copy must not affect state');
  });

  it('empty rules → list price everywhere, byte-for-byte identical (Behavior #9)', () => {
    setDiscountRules([]);
    // Cost is exactly the list-price cost with or without the date argument
    const noDate = costBreakdown('claude-opus-4-8', PARTS);
    const withDate = costBreakdown('claude-opus-4-8', PARTS, DATE);
    assert.ok(noDate && withDate);
    assert.deepEqual(withDate, noDate, 'empty rules ⇒ date is inert');
    assert.deepEqual(pricingFor('claude-opus-4-8', DATE), pricingFor('claude-opus-4-8'));
  });

  it('discounts are pricing-only: window & threshold outputs unchanged with rules set (Behavior #4)', () => {
    const before = {
      resolved: resolveModel('claude-sonnet-5-20260514'),
      window: contextWindowFor('claude-sonnet-5-20260514'),
    };
    setDiscountRules([{ model: 'claude-sonnet-5', percentOff: 75 }]);
    const after = {
      resolved: resolveModel('claude-sonnet-5-20260514'),
      window: contextWindowFor('claude-sonnet-5-20260514'),
    };
    // resolveModel (id, pricing, window) and contextWindowFor are untouched by rules
    assert.deepEqual(after.resolved, before.resolved);
    assert.equal(after.window, before.window);
  });

  it('a rule keyed by the canonical id covers dated variants', () => {
    // list reference computed with no rules active
    const list = costBreakdown('claude-sonnet-5-20260514', PARTS);
    setDiscountRules([{ model: 'claude-sonnet-5', percentOff: 50 }]);
    // a dated variant resolves to claude-sonnet-5, so the discount applies
    const bd = costBreakdown('claude-sonnet-5-20260514', PARTS, DATE);
    assert.ok(bd && list);
    assert.ok(
      Math.abs(bd.total - list.total * 0.5) < 1e-5,
      `dated variant discounted via canonical key: expected ~${list.total * 0.5}, got ${bd.total}`,
    );
  });

  it('MODEL_IDS exposes the canonical model ids', () => {
    assert.ok(MODEL_IDS.includes('claude-opus-4-8'));
    assert.ok(MODEL_IDS.includes('claude-sonnet-5'));
    assert.ok(Array.isArray(MODEL_IDS));
  });

  it('DiscountRule type is exported and usable', () => {
    const rule: DiscountRule = { model: 'claude-opus-4-8', percentOff: 25 };
    setDiscountRules([rule]);
    assert.equal(discountMultiplier('claude-opus-4-8'), 0.75);
  });
});
