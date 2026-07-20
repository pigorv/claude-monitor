import { Hono } from 'hono';
import { getDb } from '../../db/connection.js';
import { getDbStats, getStatsRollup } from '../../db/queries/stats.js';

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
      COALESCE(SUM(compaction_count), 0) as total_compactions,
      COALESCE(SUM(tool_call_count), 0) as total_tool_calls,
      COALESCE(SUM(subagent_count), 0) as total_subagents,
      COUNT(CASE WHEN compaction_count > 0 THEN 1 END) as sessions_with_compactions
    FROM sessions
  `).get() as Record<string, number>;

  // Total cost estimate is the sum of the stored per-session estimates.
  const costRow = db.prepare(`
    SELECT COALESCE(SUM(cost_estimate_usd), 0) as total FROM sessions
  `).get() as { total: number };
  const totalCostEstimate = costRow.total;

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

stats.post('/api/stats/rollup', async (c) => {
  const body = await c.req.json().catch(() => null);

  if (typeof body !== 'object' || body === null) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'Request body must be a JSON object with a "session_ids" array.',
      },
      400,
    );
  }

  const sessionIds = (body as { session_ids?: unknown }).session_ids;
  if (!Array.isArray(sessionIds)) {
    return c.json(
      {
        error: 'invalid_request',
        message: '"session_ids" is required and must be an array of session id strings.',
      },
      400,
    );
  }

  if (!sessionIds.every((id) => typeof id === 'string')) {
    return c.json(
      {
        error: 'invalid_request',
        message: 'Every element of "session_ids" must be a string.',
      },
      400,
    );
  }

  return c.json(getStatsRollup(sessionIds));
});

export { stats };
