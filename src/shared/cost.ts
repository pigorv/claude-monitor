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
 */
export function resolveModel(model: string | null | undefined): ResolvedModel | null {
  if (!model) return null;
  const lower = model.toLowerCase();

  for (const key of Object.keys(MODELS)) {
    if (new RegExp(`${escapeRegExp(key)}(?![0-9])`).test(lower)) {
      const facts = MODELS[key];
      return { id: key, pricing: facts.pricing, context_window: facts.context_window };
    }
  }

  for (const { family, id } of FAMILY_FALLBACK) {
    if (lower.includes(family)) {
      const facts = MODELS[id];
      return { id, pricing: facts.pricing, context_window: facts.context_window };
    }
  }

  return null;
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
): CostBreakdown | undefined {
  const resolved = resolveModel(model);
  if (!resolved) return undefined;

  const p = resolved.pricing;
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
): number | null {
  const breakdowns: CostBreakdown[] = [];

  const parentCost = costBreakdown(parentModel, parent);
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
    });
    if (agentCost) breakdowns.push(agentCost);
  }

  if (breakdowns.length === 0) return null;

  return round6(breakdowns.reduce((sum, b) => sum + b.total, 0));
}

/** Context window for a model, or null when unresolved. */
export function contextWindowFor(model: string | null | undefined): number | null {
  return resolveModel(model)?.context_window ?? null;
}

/** Pricing for a model, or null when unresolved. */
export function pricingFor(model: string | null | undefined): Pricing | null {
  return resolveModel(model)?.pricing ?? null;
}
