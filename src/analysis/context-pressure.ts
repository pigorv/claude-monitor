import type { TokenSnapshot } from '../ingestion/token-tracker.js';
import { resolveThreshold } from '../ingestion/token-tracker.js';

// ── Context pressure result ─────────────────────────────────────────

export interface ContextPressureResult {
  peakContextPct: number;
  avgContextPct: number;
  timeInWarningZone: number;
  timeInDangerZone: number;
  contextUtilizationScore: number;
}

// ── Computation ─────────────────────────────────────────────────────

/**
 * Score context utilization from token snapshots.
 * Pure function — no DB access.
 */
export function computeContextPressure(
  snapshots: TokenSnapshot[],
  model: string | null,
): ContextPressureResult {
  if (snapshots.length === 0) {
    return {
      peakContextPct: 0,
      avgContextPct: 0,
      timeInWarningZone: 0,
      timeInDangerZone: 0,
      contextUtilizationScore: 0,
    };
  }

  const thresholds = resolveThreshold(model);
  const { warningPct, dangerPct } = thresholds;

  let peakContextPct = 0;
  let sumContextPct = 0;
  let warningCount = 0;
  let dangerCount = 0;

  for (const s of snapshots) {
    if (s.context_pct > peakContextPct) peakContextPct = s.context_pct;
    sumContextPct += s.context_pct;
    if (s.context_pct >= warningPct) warningCount++;
    if (s.context_pct >= dangerPct) dangerCount++;
  }

  const avgContextPct = sumContextPct / snapshots.length;
  const timeInWarningZone = warningCount / snapshots.length;
  const timeInDangerZone = dangerCount / snapshots.length;

  // Score: 0 below warning, linear to 1.0 at 100%
  let contextUtilizationScore = 0;
  if (peakContextPct >= warningPct) {
    contextUtilizationScore = Math.min(
      (peakContextPct - warningPct) / (100 - warningPct),
      1.0,
    );
  }

  return {
    peakContextPct: Math.round(peakContextPct * 100) / 100,
    avgContextPct: Math.round(avgContextPct * 100) / 100,
    timeInWarningZone: Math.round(timeInWarningZone * 1000) / 1000,
    timeInDangerZone: Math.round(timeInDangerZone * 1000) / 1000,
    contextUtilizationScore: Math.round(contextUtilizationScore * 1000) / 1000,
  };
}
