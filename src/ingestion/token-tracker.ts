import { MODEL_THRESHOLDS } from '../shared/constants.js';
import type { ContextThresholds, TokenDataPoint, TranscriptMessage } from '../shared/types.js';

// ── Token snapshot computed from a single assistant message ─────────

export interface TokenSnapshot {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  context_pct: number;
  is_compaction: boolean;
}

// ── Session-level token aggregates ─────────────────────────────────

export interface TokenAggregates {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  peak_context_pct: number;
  compaction_count: number;
}

// ── Threshold resolution ───────────────────────────────────────────

/**
 * Resolve model thresholds from a model string like "claude-opus-4-6".
 * Falls back to sonnet thresholds if the model family is unrecognized.
 */
export function resolveThreshold(model: string | null | undefined): ContextThresholds {
  if (!model) return MODEL_THRESHOLDS['sonnet'];

  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_THRESHOLDS)) {
    if (lower.includes(key)) return MODEL_THRESHOLDS[key];
  }

  return MODEL_THRESHOLDS['sonnet'];
}

/**
 * Estimate context utilization percentage from cumulative input tokens.
 */
export function estimateContextPct(inputTokens: number, model: string | null | undefined): number {
  const threshold = resolveThreshold(model);
  return (inputTokens / threshold.maxTokens) * 100;
}

// ── Core token tracking ────────────────────────────────────────────

/**
 * Detect compaction: a significant drop (>30%) in cumulative input tokens
 * between consecutive assistant messages.
 */
const COMPACTION_DROP_THRESHOLD = 0.30;

/**
 * Build an ordered array of TokenSnapshots from parsed transcript messages.
 * Only assistant messages with usage info contribute snapshots.
 */
export function buildTokenSnapshots(
  messages: TranscriptMessage[],
  model?: string | null,
): TokenSnapshot[] {
  const snapshots: TokenSnapshot[] = [];
  let prevInputTokens = 0;

  for (const msg of messages) {
    if (msg.type !== 'assistant' || !msg.usage) continue;

    const resolvedModel = model ?? msg.model ?? null;
    const inputTokens = msg.usage.input_tokens;
    const outputTokens = msg.usage.output_tokens;
    const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;

    // Effective context = new tokens + cached tokens (already in context window)
    const effectiveContextTokens = inputTokens + cacheRead;

    // Detect compaction: significant drop in effective context tokens
    // Skip zero-token messages (incomplete/empty messages at session boundaries)
    const isCompaction =
      prevInputTokens > 0 &&
      effectiveContextTokens > 0 &&
      effectiveContextTokens < prevInputTokens * (1 - COMPACTION_DROP_THRESHOLD);

    snapshots.push({
      timestamp: msg.timestamp,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      context_pct: estimateContextPct(effectiveContextTokens, resolvedModel),
      is_compaction: isCompaction,
    });

    prevInputTokens = effectiveContextTokens;
  }

  return snapshots;
}

/**
 * Compute aggregate token stats from snapshots.
 */
export function computeAggregates(snapshots: TokenSnapshot[]): TokenAggregates {
  if (snapshots.length === 0) {
    return {
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      peak_context_pct: 0,
      compaction_count: 0,
    };
  }

  // input_tokens is cumulative — the last snapshot has the final total
  // (unless there was a compaction; use the max observed)
  const lastSnapshot = snapshots[snapshots.length - 1];

  // output_tokens is per-turn, so sum them
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let peakContextPct = 0;
  let compactionCount = 0;

  for (const s of snapshots) {
    totalOutput += s.output_tokens;
    totalCacheRead += s.cache_read_tokens;
    totalCacheWrite += s.cache_write_tokens;
    if (s.context_pct > peakContextPct) peakContextPct = s.context_pct;
    if (s.is_compaction) compactionCount++;
  }

  return {
    total_input_tokens: lastSnapshot.input_tokens,
    total_output_tokens: totalOutput,
    total_cache_read_tokens: totalCacheRead,
    total_cache_write_tokens: totalCacheWrite,
    peak_context_pct: Math.round(peakContextPct * 100) / 100,
    compaction_count: compactionCount,
  };
}

/**
 * Convert TokenSnapshots to TokenDataPoints (the format stored in DB / returned by API).
 */
export function snapshotsToDataPoints(snapshots: TokenSnapshot[]): TokenDataPoint[] {
  return snapshots.map((s) => ({
    timestamp: s.timestamp,
    input_tokens: s.input_tokens,
    output_tokens: s.output_tokens,
    cache_read_tokens: s.cache_read_tokens,
    context_pct: s.context_pct,
    event_type: s.is_compaction ? 'compaction' : 'assistant_message',
    is_compaction: s.is_compaction,
  }));
}
