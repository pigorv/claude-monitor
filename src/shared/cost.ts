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

/**
 * Resolve a stored model string to a known model entry.
 * Tries full-ID substring match first (e.g. `claude-opus-4-5` matches
 * `claude-opus-4-5-20251101`), then falls back by family to that family's
 * representative model. Returns null when nothing matches.
 */
export function resolveModel(model: string | null | undefined): ResolvedModel | null {
  if (!model) return null;
  const lower = model.toLowerCase();

  for (const key of Object.keys(MODELS)) {
    if (lower.includes(key)) {
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

/** Context window for a model, or null when unresolved. */
export function contextWindowFor(model: string | null | undefined): number | null {
  return resolveModel(model)?.context_window ?? null;
}

/** Pricing for a model, or null when unresolved. */
export function pricingFor(model: string | null | undefined): Pricing | null {
  return resolveModel(model)?.pricing ?? null;
}
