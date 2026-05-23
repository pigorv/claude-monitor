import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';
import { getDbStats } from '../../db/queries/stats.js';
import { MODEL_PRICING } from '../../shared/constants.js';

const stats = new Hono();

stats.get('/api/stats', (c) => {
  const dbStats = getDbStats();
  const db = getDb();

  // Parent-session-only token totals. These represent the parent transcripts
  // alone; per-agent contributions are exposed separately in
  // total_agent_input_tokens / total_agent_output_tokens so callers don't
  // mix raw per-turn parent throughput with messageId-deduped agent sums.
  const tokenRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(total_output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read_tokens,
      COALESCE(SUM(total_cache_write_tokens), 0) as total_cache_write_tokens,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
      COALESCE(SUM(compaction_count), 0) as total_compactions,
      COALESCE(SUM(tool_call_count), 0) as total_tool_calls,
      COALESCE(SUM(subagent_count), 0) as total_subagents,
      COUNT(CASE WHEN compaction_count > 0 THEN 1 END) as sessions_with_compactions
    FROM sessions
  `).get() as Record<string, number>;

  // Agent contribution: only count agents whose parent has a known model,
  // matching the cost rollup below so the three numbers stay reconcilable.
  const agentRow = db.prepare(`
    SELECT
      COALESCE(SUM(COALESCE(ar.initial_context_tokens, 0)), 0) as total_agent_input_tokens,
      COALESCE(SUM(COALESCE(ar.total_tokens_consumed, 0)), 0) as total_agent_output_tokens
    FROM agent_relationships ar
    WHERE EXISTS (
      SELECT 1 FROM sessions s WHERE s.id = ar.parent_session_id AND s.model IS NOT NULL
    )
  `).get() as Record<string, number>;

  // Per-model parent-session token totals. Agent contributions are added
  // below from a separate query (LEFT JOIN would double-count sessions
  // with multiple agents).
  const modelRows = db.prepare(`
    SELECT
      model,
      COALESCE(SUM(total_input_tokens), 0) as input_tokens,
      COALESCE(SUM(total_output_tokens), 0) as output_tokens
    FROM sessions
    WHERE model IS NOT NULL
    GROUP BY model
  `).all() as { model: string; input_tokens: number; output_tokens: number }[];

  // Per-model agent contribution: approximated by initial_context_tokens
  // (first-turn baseline — captures cache-creation pricing once) +
  // total_tokens_consumed (messageId-deduped output).
  const modelAgentRows = db.prepare(`
    SELECT
      s.model as model,
      COALESCE(SUM(COALESCE(ar.initial_context_tokens, 0)), 0) as agent_input_tokens,
      COALESCE(SUM(COALESCE(ar.total_tokens_consumed, 0)), 0) as agent_output_tokens
    FROM sessions s
    JOIN agent_relationships ar ON ar.parent_session_id = s.id
    WHERE s.model IS NOT NULL
    GROUP BY s.model
  `).all() as { model: string; agent_input_tokens: number; agent_output_tokens: number }[];
  const agentByModel = new Map<string, { input: number; output: number }>();
  for (const r of modelAgentRows) {
    agentByModel.set(r.model, { input: r.agent_input_tokens, output: r.agent_output_tokens });
  }

  let totalCostEstimate = 0;
  for (const row of modelRows) {
    const lower = row.model.toLowerCase();
    let pricingKey: string | null = null;
    for (const key of Object.keys(MODEL_PRICING)) {
      if (lower.includes(key)) { pricingKey = key; break; }
    }
    if (pricingKey) {
      const pricing = MODEL_PRICING[pricingKey];
      const agentExtra = agentByModel.get(row.model);
      const inputForCost = row.input_tokens + (agentExtra?.input ?? 0);
      const outputForCost = row.output_tokens + (agentExtra?.output ?? 0);
      totalCostEstimate += (inputForCost / 1_000_000) * pricing.input_per_mtok
        + (outputForCost / 1_000_000) * pricing.output_per_mtok;
    }
  }
  totalCostEstimate = Math.round(totalCostEstimate * 1_000_000) / 1_000_000;

  const todayRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions WHERE started_at >= date('now') AND started_at < date('now', '+1 day')
  `).get() as { cnt: number };

  return c.json({
    session_count: dbStats.sessionCount,
    event_count: dbStats.eventCount,
    db_size_bytes: dbStats.dbSizeBytes,
    oldest_session: dbStats.oldestSession,
    newest_session: dbStats.newestSession,
    total_input_tokens: tokenRow.total_input_tokens,
    total_output_tokens: tokenRow.total_output_tokens,
    total_agent_input_tokens: agentRow.total_agent_input_tokens,
    total_agent_output_tokens: agentRow.total_agent_output_tokens,
    total_cache_read_tokens: tokenRow.total_cache_read_tokens,
    total_cache_write_tokens: tokenRow.total_cache_write_tokens,
    avg_duration_ms: Math.round(tokenRow.avg_duration_ms),
    total_compactions: tokenRow.total_compactions,
    total_tool_calls: tokenRow.total_tool_calls,
    total_subagents: tokenRow.total_subagents,
    sessions_with_compactions: tokenRow.sessions_with_compactions,
    total_cost_estimate_usd: totalCostEstimate,
    sessions_today: todayRow.cnt,
  });
});

export { stats };
