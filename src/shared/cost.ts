import models from './models.json';

/** Per-MTok rates ($) for a single model. Mirrors the fields in models.json. */
export interface Pricing {
  input: number;
  output: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_write_default: number;
}

interface ModelFacts {
  pricing: Pricing;
  context_window: number;
}

const MODELS = models as Record<string, ModelFacts>;

/** Context window assumed for a model that can't be resolved to a known entry. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Representative model id for each family, used for version-fallback. */
const FAMILY_FALLBACK: Array<{ family: string; id: string }> = [
  { family: 'fable', id: 'claude-fable-5' },
  { family: 'opus', id: 'claude-opus-4-8' },
  { family: 'sonnet', id: 'claude-sonnet-4-6' },
  { family: 'haiku', id: 'claude-haiku-4-5' },
];

export interface ResolvedModel {
  id: string;
  pricing: Pricing;
  context_window: number;
}

/** Escape a literal string for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a stored model string to a known model entry.
 * Tries full-ID match first (e.g. `claude-opus-4-5` matches
 * `claude-opus-4-5-20251101`), then falls back by family to that family's
 * representative model. Returns null when nothing matches.
 *
 * Matching requires a version boundary — the key must be followed by a
 * non-digit or end-of-string — so a key like `claude-opus-4-1` does not
 * swallow a future `claude-opus-4-10`. That also removes any dependence on
 * the order of keys in models.json.
 *
 * A `[1m]` marker on a Sonnet id (e.g. `claude-sonnet-4-6[1m]`) keeps the base
 * entry's id and pricing but overrides the context window to 1,000,000. The
 * marker is scoped to Sonnet — the only family with a sub-1M base window that
 * has a 1M variant — so it stays in step with the threshold resolvers, which
 * also gate the 1M profile on Sonnet.
 */
export function resolveModel(model: string | null | undefined): ResolvedModel | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  const oneM = /\[1m\]/.test(lower) && lower.includes('sonnet');

  for (const key of Object.keys(MODELS)) {
    if (new RegExp(`${escapeRegExp(key)}(?![0-9])`).test(lower)) {
      const facts = MODELS[key];
      return {
        id: key,
        pricing: facts.pricing,
        context_window: oneM ? 1_000_000 : facts.context_window,
      };
    }
  }

  for (const { family, id } of FAMILY_FALLBACK) {
    if (lower.includes(family)) {
      const facts = MODELS[id];
      return {
        id,
        pricing: facts.pricing,
        context_window: oneM ? 1_000_000 : facts.context_window,
      };
    }
  }

  return null;
}

/** Export the canonical model ids (for config validation / dropdowns). */
export const MODEL_IDS = Object.keys(MODELS);

/**
 * A time-bounded, per-model price discount. `percentOff` is 0–100 (a value of
 * 50 means the session pays 50% of list price). `start`/`end` are inclusive ISO
 * dates (`YYYY-MM-DD`); an omitted bound is open-ended on that side.
 */
export interface DiscountRule {
  model: string;
  percentOff: number;
  start?: string;
  end?: string;
}

let DISCOUNT_RULES: DiscountRule[] = [];

/**
 * Replace the in-memory discount rules. Keeps only entries whose `percentOff`
 * is a finite number in [0, 100]; invalid entries are dropped. Order is
 * preserved — on a date overlap the first matching rule wins.
 */
export function setDiscountRules(rules: DiscountRule[]): void {
  DISCOUNT_RULES = rules.filter(
    (r) => Number.isFinite(r.percentOff) && r.percentOff >= 0 && r.percentOff <= 100,
  );
}

/** The currently-active discount rules (a shallow copy). */
export function getDiscountRules(): DiscountRule[] {
  return DISCOUNT_RULES.slice();
}

/**
 * Multiplier (fraction of list price paid) for a canonical model id on a given
 * date. Returns `1 − percentOff/100` (clamped to [0, 1]) for the first rule (in
 * file order) whose `model` equals `id` and whose date window contains the date
 * portion of `date`; otherwise `1`. A `date` of `undefined` only matches
 * always-on rules (no `start`/`end`).
 */
export function discountMultiplier(id: string, date?: string): number {
  const d = date?.slice(0, 10);
  for (const rule of DISCOUNT_RULES) {
    if (rule.model !== id) continue;
    if (d === undefined) {
      if (rule.start === undefined && rule.end === undefined) {
        return clamp01(1 - rule.percentOff / 100);
      }
      continue;
    }
    if ((!rule.start || d >= rule.start) && (!rule.end || d <= rule.end)) {
      return clamp01(1 - rule.percentOff / 100);
    }
  }
  return 1;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * List pricing scaled by the discount multiplier for a model id on a date.
 * Returns `list` unchanged when the multiplier is exactly 1.
 */
function effectivePricing(id: string, list: Pricing, date?: string): Pricing {
  const m = discountMultiplier(id, date);
  if (m === 1) return list;
  return {
    input: list.input * m,
    output: list.output * m,
    cache_read: list.cache_read * m,
    cache_write_5m: list.cache_write_5m * m,
    cache_write_1h: list.cache_write_1h * m,
    cache_write_default: list.cache_write_default * m,
  };
}

export interface CostParts {
  freshInput: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteDefault?: number;
  output: number;
}

export interface CostBreakdown {
  perType: {
    freshInput: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheWriteDefault: number;
    output: number;
  };
  total: number;
}

function round6(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}

function rate(tokens: number, perMTok: number): number {
  return round6((tokens / 1_000_000) * perMTok);
}

/**
 * Compute a per-token-type cost breakdown for a model. Returns undefined when
 * the model cannot be resolved.
 */
export function costBreakdown(
  model: string | null | undefined,
  parts: CostParts,
  date?: string,
): CostBreakdown | undefined {
  const resolved = resolveModel(model);
  if (!resolved) return undefined;

  const p = effectivePricing(resolved.id, resolved.pricing, date);
  const perType = {
    freshInput: rate(parts.freshInput, p.input),
    cacheRead: rate(parts.cacheRead, p.cache_read),
    cacheWrite5m: rate(parts.cacheWrite5m, p.cache_write_5m),
    cacheWrite1h: rate(parts.cacheWrite1h, p.cache_write_1h),
    cacheWriteDefault: rate(parts.cacheWriteDefault ?? 0, p.cache_write_default),
    output: rate(parts.output, p.output),
  };

  const total = round6(
    perType.freshInput +
      perType.cacheRead +
      perType.cacheWrite5m +
      perType.cacheWrite1h +
      perType.cacheWriteDefault +
      perType.output,
  );

  return { perType, total };
}

/**
 * Compute the full per-session cost (parent + per-agent) in USD, each term
 * priced at its own model. Sub-agents are priced at their own model when set,
 * else fall back to the parent model. Returns null when no term resolves to a
 * known model (unresolvable → no cost).
 */
export function sessionCostUsd(
  parentModel: string | null,
  parent: {
    freshInput: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheWriteDefault: number;
    output: number;
  },
  agents: ReadonlyArray<{
    model: string | null;
    freshInput: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
  }>,
  date?: string,
): number | null {
  const breakdowns: CostBreakdown[] = [];

  const parentCost = costBreakdown(parentModel, parent, date);
  if (parentCost) breakdowns.push(parentCost);

  for (const agent of agents) {
    const agentCost = costBreakdown(agent.model ?? parentModel, {
      freshInput: agent.freshInput,
      cacheRead: agent.cacheRead,
      cacheWrite5m: agent.cacheWrite5m,
      cacheWrite1h: agent.cacheWrite1h,
      // agent_relationships only stores the 5m/1h split, not a residual
      // cache-write bucket, so a sub-agent's residual (if the API ever emits
      // one beyond 5m + 1h) can't be priced here. It's exactly 0 under the
      // current cache_creation breakdown.
      cacheWriteDefault: 0,
      output: agent.output,
    }, date);
    if (agentCost) breakdowns.push(agentCost);
  }

  if (breakdowns.length === 0) return null;

  return round6(breakdowns.reduce((sum, b) => sum + b.total, 0));
}

/** Context window for a model, or null when unresolved. */
export function contextWindowFor(model: string | null | undefined): number | null {
  return resolveModel(model)?.context_window ?? null;
}

/** Pricing for a model on a given date (discount applied), or null when unresolved. */
export function pricingFor(model: string | null | undefined, date?: string): Pricing | null {
  const resolved = resolveModel(model);
  if (!resolved) return null;
  return effectivePricing(resolved.id, resolved.pricing, date);
}
