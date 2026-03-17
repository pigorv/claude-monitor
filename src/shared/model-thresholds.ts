import type { ContextThresholds } from './types.js';

/**
 * Model context-window thresholds used by both backend ingestion and frontend charts.
 * This module is kept free of Node-specific imports so it can be consumed by Vite.
 */
export const MODEL_THRESHOLDS: Record<string, ContextThresholds> = {
  opus:   { model: 'opus',   maxTokens: 1_000_000, autoCompactPct: 96.7,  warningPct: 60.0, dangerPct: 70.0 },
  sonnet: { model: 'sonnet', maxTokens: 200_000, autoCompactPct: 83.5,  warningPct: 65.0, dangerPct: 75.0 },
  haiku:  { model: 'haiku',  maxTokens: 200_000, autoCompactPct: 90.0,  warningPct: 70.0, dangerPct: 80.0 },
};
