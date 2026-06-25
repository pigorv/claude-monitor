import type { ContextThresholds } from './types.js';
import { contextWindowFor } from './cost.js';

/**
 * Per-family compaction/warning/danger percentages. The context window
 * (`maxTokens`) is sourced from models.json via `contextWindowFor` so the
 * window lives in one place; see MODEL_THRESHOLDS below.
 */
const THRESHOLD_PCTS: Record<string, Omit<ContextThresholds, 'maxTokens'>> = {
  fable:  { model: 'fable',  autoCompactPct: 96.7,  warningPct: 60.0, dangerPct: 70.0 },
  opus:   { model: 'opus',   autoCompactPct: 96.7,  warningPct: 60.0, dangerPct: 70.0 },
  sonnet: { model: 'sonnet', autoCompactPct: 83.5,  warningPct: 65.0, dangerPct: 75.0 },
  haiku:  { model: 'haiku',  autoCompactPct: 90.0,  warningPct: 70.0, dangerPct: 80.0 },
};

/**
 * Model context thresholds used by both backend ingestion and frontend charts.
 * `maxTokens` is the model's context window, sourced from models.json
 * (`contextWindowFor`) keyed by the family name, falling back to 200_000.
 * This module is kept free of Node-specific imports so it can be consumed by Vite.
 */
export const MODEL_THRESHOLDS: Record<string, ContextThresholds> = Object.fromEntries(
  Object.entries(THRESHOLD_PCTS).map(([family, pcts]) => [
    family,
    { ...pcts, maxTokens: contextWindowFor(family) ?? 200_000 },
  ]),
);

/**
 * Thresholds for the 1M-context Sonnet variant (model ids tagged `[1m]`).
 * Claude Code's auto-compaction reserves roughly the same *absolute* headroom
 * regardless of window size — the 200K Sonnet's 83.5% leaves ~33K free, and
 * that same ~33K against a 1M window lands near 96.7%. So the 1M Sonnet follows
 * the 1M-model (opus/fable) compaction profile, not the 200K Sonnet's. Keyed
 * separately from MODEL_THRESHOLDS so the family-detection loops that iterate
 * its keys stay unpolluted; `resolveThreshold`/`resolveThresholds` branch to it
 * explicitly on the `[1m]` marker.
 */
export const SONNET_1M_THRESHOLDS: ContextThresholds = {
  model: 'sonnet',
  autoCompactPct: 96.7,
  warningPct: 60.0,
  dangerPct: 70.0,
  maxTokens: contextWindowFor('claude-sonnet-4-6[1m]') ?? 1_000_000,
};
