import { MODEL_THRESHOLDS, SONNET_1M_THRESHOLDS } from '../shared/constants.js';
import { contextWindowFor } from '../shared/cost.js';
import type { ContextThresholds, TranscriptMessage } from '../shared/types.js';

// ── Token snapshot computed from a single assistant message ─────────

export interface TokenSnapshot {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  context_pct: number;
  is_compaction: boolean;
}

// ── Session-level token aggregates ─────────────────────────────────

export interface TokenAggregates {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_input_tokens_billed: number;
  total_cache_write_5m_tokens: number;
  total_cache_write_1h_tokens: number;
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
  // The 1M-context Sonnet variant ([1m]) follows the 1M compaction profile.
  if (/\[1m\]/.test(lower) && lower.includes('sonnet')) return SONNET_1M_THRESHOLDS;
  for (const key of Object.keys(MODEL_THRESHOLDS)) {
    if (lower.includes(key)) return MODEL_THRESHOLDS[key];
  }

  return MODEL_THRESHOLDS['sonnet'];
}

/**
 * Estimate context utilization percentage from cumulative input tokens.
 * The context window is sourced from models.json (`contextWindowFor`),
 * falling back to the resolved family's threshold window.
 */
export function estimateContextPct(inputTokens: number, model: string | null | undefined): number {
  const maxTokens = contextWindowFor(model) ?? resolveThreshold(model).maxTokens;
  return (inputTokens / maxTokens) * 100;
}

// ── Core token tracking ────────────────────────────────────────────

/**
 * Detect compaction: a significant drop (>30%) in cumulative input tokens
 * between consecutive assistant messages.
 */
const COMPACTION_DROP_THRESHOLD = 0.30;

/**
 * Keep one line per messageId — the LAST occurrence, which carries the final
 * cumulative usage for a streamed message. Lines without a messageId are each
 * kept. Order is preserved. Shared by buildTokenSnapshots() and the subagent
 * token summation so both dedup identically.
 */
export function dedupeByMessageId(messages: TranscriptMessage[]): TranscriptMessage[] {
  const lastIndexById = new Map<string, number>();
  messages.forEach((m, i) => { if (m.messageId) lastIndexById.set(m.messageId, i); });
  return messages.filter((m, i) => !m.messageId || lastIndexById.get(m.messageId) === i);
}

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

  const deduped = dedupeByMessageId(messages);

  for (const msg of deduped) {
    if (msg.type !== 'assistant' || !msg.usage) continue;

    const resolvedModel = model ?? msg.model ?? null;
    const inputTokens = msg.usage.input_tokens;
    const outputTokens = msg.usage.output_tokens;
    const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;
    const cacheWrite5m = msg.usage.cache_creation_5m_input_tokens ?? 0;
    const cacheWrite1h = msg.usage.cache_creation_1h_input_tokens ?? 0;

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
      cache_write_5m_tokens: cacheWrite5m,
      cache_write_1h_tokens: cacheWrite1h,
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
      total_input_tokens_billed: 0,
      total_cache_write_5m_tokens: 0,
      total_cache_write_1h_tokens: 0,
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
  let totalInputBilled = 0;
  let total5m = 0;
  let total1h = 0;
  let peakContextPct = 0;
  let compactionCount = 0;

  for (const s of snapshots) {
    const effective = s.input_tokens + s.cache_read_tokens + s.cache_write_tokens;
    if (effective > maxEffectiveContext) maxEffectiveContext = effective;
    totalOutput += s.output_tokens;
    totalCacheRead += s.cache_read_tokens;
    totalCacheWrite += s.cache_write_tokens;
    totalInputBilled += s.input_tokens;
    total5m += s.cache_write_5m_tokens;
    total1h += s.cache_write_1h_tokens;
    if (s.context_pct > peakContextPct) peakContextPct = s.context_pct;
    if (s.is_compaction) compactionCount++;
  }

  return {
    total_input_tokens: maxEffectiveContext,
    total_output_tokens: totalOutput,
    total_cache_read_tokens: totalCacheRead,
    total_cache_write_tokens: totalCacheWrite,
    total_input_tokens_billed: totalInputBilled,
    total_cache_write_5m_tokens: total5m,
    total_cache_write_1h_tokens: total1h,
    peak_context_pct: Math.round(peakContextPct * 100) / 100,
    compaction_count: compactionCount,
  };
}
