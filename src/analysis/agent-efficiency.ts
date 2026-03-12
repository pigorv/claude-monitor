import { MODEL_THRESHOLDS } from '../shared/constants.js';
import type { AgentRelationship, TokenDataPoint } from '../shared/types.js';

// ── Types ──────────────────────────────────────────────────────────

export interface AgentEfficiencyResult {
  prompt_tokens: number | null;
  result_tokens: number | null;
  peak_context_tokens: number | null;
  compression_ratio: number | null;
  agent_compaction_count: number;
  parent_headroom_at_return: number | null;
  parent_impact_pct: number | null;
  result_classification: 'normal' | 'large' | 'oversized' | null;
  execution_mode: 'sequential' | 'parallel' | null;
  files_read_count: number;
  files_total_tokens: number;
}

// ── Compression ratio thresholds ──────────────────────────────────

export const COMPRESSION_THRESHOLDS = {
  excellent: 20,  // > 20:1
  good: 5,        // 5:1 – 20:1
  fair: 2,        // 2:1 – 5:1
  // < 2:1 is poor
} as const;

export type CompressionRating = 'excellent' | 'good' | 'fair' | 'poor';

export function rateCompression(ratio: number | null): CompressionRating {
  if (ratio == null || ratio <= 0) return 'poor';
  if (ratio > COMPRESSION_THRESHOLDS.excellent) return 'excellent';
  if (ratio > COMPRESSION_THRESHOLDS.good) return 'good';
  if (ratio > COMPRESSION_THRESHOLDS.fair) return 'fair';
  return 'poor';
}

export function compressionColor(rating: CompressionRating): string {
  switch (rating) {
    case 'excellent':
    case 'good':
      return 'green';
    case 'fair':
      return 'yellow';
    case 'poor':
      return 'red';
  }
}

// ── Result size classification ────────────────────────────────────

export function classifyResultSize(
  resultTokens: number | null,
  parentHeadroom: number | null,
): 'normal' | 'large' | 'oversized' | null {
  if (resultTokens == null || parentHeadroom == null || parentHeadroom <= 0) return null;
  const pct = (resultTokens / parentHeadroom) * 100;
  if (pct > 15) return 'oversized';
  if (pct > 5) return 'large';
  return 'normal';
}

// ── Resolve max tokens for a model ────────────────────────────────

function resolveMaxTokens(model: string | null): number {
  if (!model) return 200_000;
  const lower = model.toLowerCase();
  for (const [key, thresholds] of Object.entries(MODEL_THRESHOLDS)) {
    if (lower.includes(key)) return thresholds.maxTokens;
  }
  return 200_000;
}

// ── Per-agent efficiency computation ──────────────────────────────

/**
 * Compute efficiency metrics for a single agent.
 *
 * @param promptData - The full prompt text sent to the agent (from Task tool input)
 * @param resultData - The full result text returned by the agent
 * @param agentTokenTimeline - Token timeline from the agent's events
 * @param parentInputTokensAtReturn - Parent's cumulative input tokens when agent result enters
 * @param model - Model name for max token resolution
 */
export function computeAgentEfficiency(
  promptData: string | null,
  resultData: string | null,
  agentTokenTimeline: TokenDataPoint[],
  parentInputTokensAtReturn: number | null,
  model: string | null,
): AgentEfficiencyResult {
  // Estimate token counts from text length (rough: ~4 chars per token)
  const promptTokens = promptData ? Math.ceil(promptData.length / 4) : null;
  const resultTokens = resultData ? Math.ceil(resultData.length / 4) : null;

  // Peak context from agent's timeline
  let peakContextTokens: number | null = null;
  let agentCompactionCount = 0;
  const filesReadCount = 0;
  const filesTotalTokens = 0;

  if (agentTokenTimeline.length > 0) {
    peakContextTokens = 0;
    for (const point of agentTokenTimeline) {
      if (point.input_tokens > peakContextTokens) {
        peakContextTokens = point.input_tokens;
      }
      if (point.is_compaction) {
        agentCompactionCount++;
      }
    }
  }

  // Compression ratio: peak context consumed / result size
  let compressionRatio: number | null = null;
  if (peakContextTokens != null && peakContextTokens > 0 && resultTokens != null && resultTokens > 0) {
    compressionRatio = Math.round((peakContextTokens / resultTokens) * 10) / 10;
  }

  // Parent headroom and impact
  const maxTokens = resolveMaxTokens(model);
  let parentHeadroom: number | null = null;
  let parentImpactPct: number | null = null;

  if (parentInputTokensAtReturn != null) {
    parentHeadroom = maxTokens - parentInputTokensAtReturn;
    if (parentHeadroom > 0 && resultTokens != null) {
      parentImpactPct = Math.round((resultTokens / parentHeadroom) * 1000) / 10;
    }
  }

  const resultClassification = classifyResultSize(resultTokens, parentHeadroom);

  return {
    prompt_tokens: promptTokens,
    result_tokens: resultTokens,
    peak_context_tokens: peakContextTokens,
    compression_ratio: compressionRatio,
    agent_compaction_count: agentCompactionCount,
    parent_headroom_at_return: parentHeadroom,
    parent_impact_pct: parentImpactPct,
    result_classification: resultClassification,
    execution_mode: null, // Set later by inferExecutionMode
    files_read_count: filesReadCount,
    files_total_tokens: filesTotalTokens,
  };
}

// ── Execution mode inference ──────────────────────────────────────

/**
 * Determine execution mode for each agent based on timestamp overlaps.
 * An agent is "parallel" if its [start, end] interval overlaps with
 * any other agent's interval.
 */
export function inferExecutionModes(
  agents: Array<{ started_at: string | null; ended_at: string | null }>,
): ('sequential' | 'parallel')[] {
  const intervals = agents.map((a) => ({
    start: a.started_at ? new Date(a.started_at).getTime() : 0,
    end: a.ended_at ? new Date(a.ended_at).getTime() : 0,
  }));

  return intervals.map((interval, i) => {
    if (interval.start === 0 || interval.end === 0) return 'sequential';

    for (let j = 0; j < intervals.length; j++) {
      if (i === j) continue;
      const other = intervals[j];
      if (other.start === 0 || other.end === 0) continue;

      // Check overlap: intervals overlap if one starts before the other ends
      if (interval.start < other.end && other.start < interval.end) {
        return 'parallel';
      }
    }
    return 'sequential';
  });
}

// ── Peak concurrency ─────────────────────────────────────────────

/**
 * Compute the maximum number of agents running simultaneously.
 */
export function computePeakConcurrency(
  agents: Array<{ started_at: string | null; ended_at: string | null }>,
): number {
  if (agents.length === 0) return 0;

  // Create events: +1 for start, -1 for end
  const timeEvents: Array<{ time: number; delta: number }> = [];

  for (const agent of agents) {
    if (!agent.started_at || !agent.ended_at) continue;
    timeEvents.push({ time: new Date(agent.started_at).getTime(), delta: 1 });
    timeEvents.push({ time: new Date(agent.ended_at).getTime(), delta: -1 });
  }

  // Sort by time, starts before ends at same time
  timeEvents.sort((a, b) => a.time - b.time || b.delta - a.delta);

  let current = 0;
  let peak = 0;

  for (const evt of timeEvents) {
    current += evt.delta;
    if (current > peak) peak = current;
  }

  return peak;
}

// ── Files read analysis ──────────────────────────────────────────

/**
 * Count files read and total tokens from Read tool calls in agent events.
 */
export function analyzeAgentFileReads(
  events: Array<{ tool_name: string | null; output_data: string | null }>,
): { filesReadCount: number; filesTotalTokens: number } {
  let filesReadCount = 0;
  let filesTotalTokens = 0;

  for (const evt of events) {
    if (evt.tool_name === 'Read' && evt.output_data) {
      filesReadCount++;
      filesTotalTokens += Math.ceil(evt.output_data.length / 4);
    }
  }

  return { filesReadCount, filesTotalTokens };
}

// ── Session-level aggregates ─────────────────────────────────────

export interface SessionAgentAggregates {
  agent_avg_compression: number | null;
  agent_total_tokens: number;
  agent_pressure_events: number;
  agent_compacted_count: number;
  peak_concurrency: number;
}

/**
 * Compute session-level agent efficiency aggregates.
 */
export function computeSessionAgentAggregates(
  agents: AgentRelationship[],
): SessionAgentAggregates {
  if (agents.length === 0) {
    return {
      agent_avg_compression: null,
      agent_total_tokens: 0,
      agent_pressure_events: 0,
      agent_compacted_count: 0,
      peak_concurrency: 0,
    };
  }

  let compressionSum = 0;
  let compressionCount = 0;
  let totalTokens = 0;
  let pressureEvents = 0;
  let compactedCount = 0;

  for (const agent of agents) {
    if (agent.compression_ratio != null && agent.compression_ratio > 0) {
      compressionSum += agent.compression_ratio;
      compressionCount++;
    }
    if (agent.peak_context_tokens != null) {
      totalTokens += agent.peak_context_tokens;
    }
    if (agent.result_classification && agent.result_classification !== 'normal') {
      pressureEvents++;
    }
    if (agent.agent_compaction_count > 0) {
      compactedCount++;
    }
  }

  const peakConcurrency = computePeakConcurrency(agents);

  return {
    agent_avg_compression: compressionCount > 0
      ? Math.round((compressionSum / compressionCount) * 10) / 10
      : null,
    agent_total_tokens: totalTokens,
    agent_pressure_events: pressureEvents,
    agent_compacted_count: compactedCount,
    peak_concurrency: peakConcurrency,
  };
}
