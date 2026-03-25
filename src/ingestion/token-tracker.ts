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

  // Deduplicate: when multiple JSONL lines share the same messageId, only
  // process the last one (it carries the final cumulative usage data).
  const skipIndices = new Set<number>();
  const lastByMessageId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const mid = messages[i].messageId;
    if (mid) {
      const prev = lastByMessageId.get(mid);
      if (prev !== undefined) skipIndices.add(prev);
      lastByMessageId.set(mid, i);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    if (skipIndices.has(i)) continue;
    const msg = messages[i];
    if (msg.type !== 'assistant' || !msg.usage) continue;

    const resolvedModel = model ?? msg.model ?? null;
    const inputTokens = msg.usage.input_tokens;
    const outputTokens = msg.usage.output_tokens;
    const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;

    // Effective context = new tokens + cached tokens (already in context window)
    // All three components are in the context window:
    // - input_tokens: non-cached input
    // - cache_read: tokens read from cache
    // - cache_write: tokens being written to cache for the first time
    const effectiveContextTokens = inputTokens + cacheRead + cacheWrite;

    // Skip zero-token messages (empty responses after /exit, etc.)
    if (effectiveContextTokens === 0 && outputTokens === 0) continue;

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
 *
 * After streaming dedup (handled upstream), each snapshot represents one
 * unique API call. The per-call token fields are:
 *
 *   - output_tokens: tokens generated in THIS call (incremental) -- sum gives total output
 *   - cache_read_tokens: tokens served from cache in THIS call (incremental) -- sum gives total reads
 *   - cache_write_tokens: tokens written to cache in THIS call (incremental) -- sum gives total writes
 *   - input_tokens: non-cached input tokens in THIS call
 *
 * total_input_tokens uses the MAX effective context (input + cache_read + cache_write)
 * across all snapshots, representing peak context window usage. This correctly
 * handles compaction resets -- summing would double-count pre/post compaction tokens.
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

  // Effective context = input + cache_read + cache_write per snapshot.
  // Use the max effective context seen (handles compaction resets).
  let maxEffectiveContext = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let peakContextPct = 0;
  let compactionCount = 0;

  for (const s of snapshots) {
    const effective = s.input_tokens + s.cache_read_tokens + s.cache_write_tokens;
    if (effective > maxEffectiveContext) maxEffectiveContext = effective;
    totalOutput += s.output_tokens;
    totalCacheRead += s.cache_read_tokens;
    totalCacheWrite += s.cache_write_tokens;
    if (s.context_pct > peakContextPct) peakContextPct = s.context_pct;
    if (s.is_compaction) compactionCount++;
  }

  return {
    total_input_tokens: maxEffectiveContext,
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
    cache_write_tokens: s.cache_write_tokens,
    context_pct: s.context_pct,
    event_type: s.is_compaction ? 'compaction' : 'assistant_message',
    is_compaction: s.is_compaction,
  }));
}
