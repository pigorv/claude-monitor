import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';
import { getDbStats } from '../../db/queries/stats.js';
import { MODEL_PRICING } from '../../shared/constants.js';

const stats = new Hono();

stats.get('/api/stats', (c) => {
  const dbStats = getDbStats();
  const db = getDb();

  const tokenRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(total_output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read_tokens,
      COALESCE(SUM(total_cache_write_tokens), 0) as total_cache_write_tokens,
      COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
      COALESCE(AVG(risk_score), 0) as avg_risk_score,
      COALESCE(SUM(compaction_count), 0) as total_compactions,
      COALESCE(SUM(tool_call_count), 0) as total_tool_calls,
      COALESCE(SUM(subagent_count), 0) as total_subagents,
      COUNT(CASE WHEN compaction_count > 0 THEN 1 END) as sessions_with_compactions
    FROM sessions
  `).get() as Record<string, number>;

  // Compute total cost estimate by model
  const modelRows = db.prepare(`
    SELECT
      model,
      COALESCE(SUM(total_input_tokens), 0) as input_tokens,
      COALESCE(SUM(total_output_tokens), 0) as output_tokens
    FROM sessions
    WHERE model IS NOT NULL
    GROUP BY model
  `).all() as { model: string; input_tokens: number; output_tokens: number }[];

  let totalCostEstimate = 0;
  for (const row of modelRows) {
    const lower = row.model.toLowerCase();
    let pricingKey: string | null = null;
    for (const key of Object.keys(MODEL_PRICING)) {
      if (lower.includes(key)) { pricingKey = key; break; }
    }
    if (pricingKey) {
      const pricing = MODEL_PRICING[pricingKey];
      totalCostEstimate += (row.input_tokens / 1_000_000) * pricing.input_per_mtok
        + (row.output_tokens / 1_000_000) * pricing.output_per_mtok;
    }
  }
  totalCostEstimate = Math.round(totalCostEstimate * 1_000_000) / 1_000_000;

  const highRiskRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions WHERE risk_score >= 0.6
  `).get() as { cnt: number };

  const todayRow = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions WHERE date(started_at) = date('now')
  `).get() as { cnt: number };

  return c.json({
    session_count: dbStats.sessionCount,
    event_count: dbStats.eventCount,
    db_size_bytes: dbStats.dbSizeBytes,
    oldest_session: dbStats.oldestSession,
    newest_session: dbStats.newestSession,
    total_input_tokens: tokenRow.total_input_tokens,
    total_output_tokens: tokenRow.total_output_tokens,
    total_cache_read_tokens: tokenRow.total_cache_read_tokens,
    total_cache_write_tokens: tokenRow.total_cache_write_tokens,
    avg_duration_ms: Math.round(tokenRow.avg_duration_ms),
    avg_risk_score: Math.round(tokenRow.avg_risk_score * 100) / 100,
    total_compactions: tokenRow.total_compactions,
    total_tool_calls: tokenRow.total_tool_calls,
    total_subagents: tokenRow.total_subagents,
    sessions_with_compactions: tokenRow.sessions_with_compactions,
    total_cost_estimate_usd: totalCostEstimate,
    high_risk_sessions: highRiskRow.cnt,
    sessions_today: todayRow.cnt,
  });
});

export { stats };
