import type { TokenSnapshot } from '../ingestion/token-tracker.js';
import type { ParsedEvent } from '../ingestion/thinking-extractor.js';
import type { RiskAssessment, RiskLevel, RiskSignal } from '../shared/types.js';
import { computeContextPressure } from './context-pressure.js';

// ── Input type ──────────────────────────────────────────────────────

export interface RiskInput {
  snapshots: TokenSnapshot[];
  events: ParsedEvent[];
  model: string | null;
  compactionCount: number;
  subagentCount: number;
}

// ── Risk level mapping ──────────────────────────────────────────────

export function riskLevel(score: number): RiskLevel {
  if (score >= 0.8) return 'critical';
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

// ── Long output threshold (chars) ───────────────────────────────────

const LONG_OUTPUT_CHARS = 40_000;

// ── Composite risk scoring ──────────────────────────────────────────

export function computeRiskAssessment(input: RiskInput): RiskAssessment {
  const { snapshots, events, model, compactionCount, subagentCount } = input;
  const signals: RiskSignal[] = [];

  // 1. Context utilization (weight 0.30)
  const pressure = computeContextPressure(snapshots, model);
  signals.push({
    name: 'context_utilization',
    value: pressure.contextUtilizationScore,
    weight: 0.30,
    description: `Peak context ${pressure.peakContextPct.toFixed(1)}%, avg ${pressure.avgContextPct.toFixed(1)}%`,
  });

  // 2. Compaction count (weight 0.25) — caps at 3
  const compactionValue = Math.min(compactionCount / 3, 1.0);
  signals.push({
    name: 'compaction_count',
    value: compactionValue,
    weight: 0.25,
    description: `${compactionCount} compaction${compactionCount !== 1 ? 's' : ''} detected`,
  });

  // 3. Post-compaction drift (weight 0.20)
  const driftValue = computePostCompactionDrift(snapshots, events);
  signals.push({
    name: 'post_compaction_drift',
    value: driftValue,
    weight: 0.20,
    description: `${Math.round(driftValue * 100)}% of tool calls after last compaction`,
  });

  // 4. Long tool output (weight 0.15)
  const longOutputCount = events.filter(
    (e) => e.event_type === 'tool_call_end' && e.output_data && e.output_data.length > LONG_OUTPUT_CHARS,
  ).length;
  const longOutputValue = Math.min(longOutputCount / 5, 1.0);
  signals.push({
    name: 'long_tool_output',
    value: longOutputValue,
    weight: 0.15,
    description: `${longOutputCount} tool output${longOutputCount !== 1 ? 's' : ''} exceeding 40K chars`,
  });

  // 5. Deep nesting / subagents (weight 0.10) — caps at 3
  const nestingValue = Math.min(subagentCount / 3, 1.0);
  signals.push({
    name: 'deep_nesting',
    value: nestingValue,
    weight: 0.10,
    description: `${subagentCount} subagent${subagentCount !== 1 ? 's' : ''} spawned`,
  });

  // Composite score
  let score = 0;
  for (const s of signals) {
    score += s.value * s.weight;
  }
  score = Math.round(Math.min(Math.max(score, 0), 1) * 1000) / 1000;

  return {
    score,
    level: riskLevel(score),
    signals,
  };
}

// ── Post-compaction drift helper ────────────────────────────────────

function computePostCompactionDrift(
  snapshots: TokenSnapshot[],
  events: ParsedEvent[],
): number {
  // Find timestamp of last compaction
  let lastCompactionTimestamp: string | null = null;
  for (const s of snapshots) {
    if (s.is_compaction) lastCompactionTimestamp = s.timestamp;
  }

  if (!lastCompactionTimestamp) return 0;

  const toolCalls = events.filter((e) => e.event_type === 'tool_call_start');
  if (toolCalls.length === 0) return 0;

  const postCompactionCalls = toolCalls.filter(
    (e) => e.timestamp > lastCompactionTimestamp!,
  ).length;

  return Math.round((postCompactionCalls / toolCalls.length) * 1000) / 1000;
}
