import { Hono } from 'hono';
import type {
  Session,
  SessionSummary,
  SessionListResponse,
  SessionDetailResponse,
  RiskAssessment,
  SessionStats,
  InternalToolCall,
} from '../../shared/types.js';
import { getSession, listSessions, getAgentRelationships, getAgentToolCalls, getAgentTokenTimeline, getLinkedSessions } from '../../db/queries/sessions.js';
import { getTokenTimeline, getMiniTimeline, getEventCountBySession } from '../../db/queries/events.js';
import { getSessionStats, getToolFrequency } from '../../db/queries/stats.js';
import type { SessionFilters } from '../../db/queries/sessions.js';
import { riskLevel } from '../../analysis/risk-scoring.js';
import { MODEL_PRICING } from '../../shared/constants.js';
import { analyzeCompactions } from '../../analysis/compaction-analysis.js';

const sessions = new Hono();

function resolveModelKey(model: string | null): string | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_PRICING)) {
    if (lower.includes(key)) return key;
  }
  return null;
}

function estimateCost(model: string | null, inputTokens: number, outputTokens: number): number | undefined {
  const key = resolveModelKey(model);
  if (!key) return undefined;
  const pricing = MODEL_PRICING[key];
  const cost = (inputTokens / 1_000_000) * pricing.input_per_mtok + (outputTokens / 1_000_000) * pricing.output_per_mtok;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function sessionToSummary(session: Session): SessionSummary {
  const score = session.risk_score ?? 0;
  const miniTimeline = getMiniTimeline(session.id);
  return {
    id: session.id,
    project_name: session.project_name ?? 'unknown',
    project_path: session.project_path ?? undefined,
    model: session.model ?? 'unknown',
    status: session.status,
    started_at: session.started_at,
    duration_ms: session.duration_ms ?? 0,
    total_input_tokens: session.total_input_tokens,
    total_output_tokens: session.total_output_tokens,
    peak_context_pct: session.peak_context_pct ?? 0,
    compaction_count: session.compaction_count,
    tool_call_count: session.tool_call_count,
    subagent_count: session.subagent_count,
    risk_score: score,
    risk_level: riskLevel(score),
    summary: session.summary ?? '',
    cost_estimate_usd: estimateCost(session.model, session.total_input_tokens, session.total_output_tokens),
    mini_timeline: miniTimeline,
  };
}

sessions.get('/api/sessions', (c) => {
  const q = c.req.query.bind(c.req);

  const filters: SessionFilters = {};
  if (q('project')) filters.project = q('project');
  if (q('status')) filters.status = q('status');
  if (q('model')) filters.model = q('model');
  if (q('since')) filters.since = q('since');
  if (q('until')) filters.until = q('until');
  if (q('min_risk')) {
    const v = parseFloat(q('min_risk')!);
    if (!isNaN(v)) filters.minRisk = v;
  }
  if (q('q')) filters.q = q('q');
  if (q('sort')) filters.sort = q('sort');
  if (q('order') === 'asc' || q('order') === 'desc') filters.order = q('order') as 'asc' | 'desc';
  if (q('limit')) {
    const v = parseInt(q('limit')!, 10);
    if (!isNaN(v) && v > 0) filters.limit = v;
  }
  if (q('offset')) {
    const v = parseInt(q('offset')!, 10);
    if (!isNaN(v) && v >= 0) filters.offset = v;
  }

  const { sessions: rows, total } = listSessions(filters);

  const response: SessionListResponse = {
    sessions: rows.map(sessionToSummary),
    total,
    limit: filters.limit ?? 50,
    offset: filters.offset ?? 0,
  };

  return c.json(response);
});

sessions.get('/api/sessions/:id', (c) => {
  const id = c.req.param('id');
  const session = getSession(id);

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const tokenTimeline = getTokenTimeline(id);
  const agents = getAgentRelationships(id);
  const stats = getSessionStats(id);
  const toolFreq = getToolFrequency(id);

  const score = session.risk_score ?? 0;
  let signals: RiskAssessment['signals'] = [];
  if (session.metadata) {
    try {
      const parsed = JSON.parse(session.metadata);
      signals = parsed.risk_signals ?? [];
    } catch {
      // Metadata is corrupt — ignore and use empty signals
    }
  }
  const risk: RiskAssessment = {
    score,
    level: riskLevel(score),
    signals,
  };

  const toolFrequency: Record<string, number> = {};
  for (const entry of toolFreq) {
    toolFrequency[entry.tool_name] = entry.count;
  }

  const sessionStats: SessionStats = {
    unique_tools: stats.uniqueTools,
    tool_frequency: toolFrequency,
    avg_tool_duration_ms: stats.avgDurationMs,
    files_read: stats.filesRead,
    files_written: stats.filesWritten,
  };

  // Compaction analysis (Story 2.6)
  const compactionDetails = analyzeCompactions(id);

  // Agent internal tool calls + efficiency data (Story 2.7 + agent efficiency)
  const agentsWithTools = agents.map((agent) => {
    const toolCalls = getAgentToolCalls(id, agent.child_agent_id);
    const internalToolCalls: InternalToolCall[] = toolCalls.map((tc) => ({
      tool_name: tc.tool_name,
      file_path: tc.file_path ?? undefined,
      duration_ms: tc.duration_ms ?? undefined,
      result_char_count: tc.result_char_count ?? undefined,
      estimated_tokens: tc.result_char_count != null ? Math.round(tc.result_char_count / 4) : undefined,
      input_preview: tc.input_preview ?? undefined,
      result_preview: tc.result_preview ?? undefined,
    }));
    const agentTimeline = getAgentTokenTimeline(id, agent.child_agent_id);
    return { ...agent, internal_tool_calls: internalToolCalls, token_timeline: agentTimeline };
  });

  // Agent efficiency aggregates
  let agentEfficiency = undefined;
  if (agents.length >= 2) {
    const durations = agents.filter(a => a.duration_ms != null).map(a => a.duration_ms!);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d, 0) / durations.length) : null;

    let compressionSum = 0;
    let compressionCount = 0;
    let aggregateTokens = 0;
    let agentsWithCompaction = 0;
    let parentPressure = 0;
    let peakConcurrency = 0;

    // Compute peak concurrency from timestamps
    const timeEvents: Array<{ time: number; delta: number }> = [];
    for (const a of agents) {
      if (a.started_at && a.ended_at) {
        timeEvents.push({ time: new Date(a.started_at).getTime(), delta: 1 });
        timeEvents.push({ time: new Date(a.ended_at).getTime(), delta: -1 });
      }
    }
    timeEvents.sort((a, b) => a.time - b.time || b.delta - a.delta);
    let current = 0;
    for (const evt of timeEvents) {
      current += evt.delta;
      if (current > peakConcurrency) peakConcurrency = current;
    }

    for (const a of agents) {
      if (a.compression_ratio != null && a.compression_ratio > 0) {
        compressionSum += a.compression_ratio;
        compressionCount++;
      }
      if (a.peak_context_tokens != null) {
        aggregateTokens += a.peak_context_tokens;
      }
      if (a.agent_compaction_count > 0) {
        agentsWithCompaction++;
      }
      if (a.result_classification && a.result_classification !== 'normal') {
        parentPressure++;
      }
    }

    agentEfficiency = {
      total_agents: agents.length,
      aggregate_tokens: aggregateTokens,
      avg_compression_ratio: compressionCount > 0 ? Math.round((compressionSum / compressionCount) * 10) / 10 : null,
      agents_with_compaction: agentsWithCompaction,
      parent_pressure_events: parentPressure,
      avg_agent_duration_ms: avgDuration,
      peak_concurrency: peakConcurrency,
    };
  }

  const eventCount = getEventCountBySession(id);
  const linkedSessions = getLinkedSessions(id);

  const response: SessionDetailResponse = {
    session,
    token_timeline: tokenTimeline,
    agents: agentsWithTools,
    risk,
    stats: sessionStats,
    compaction_details: compactionDetails,
    event_count: eventCount,
    agent_efficiency: agentEfficiency,
    linked_sessions: linkedSessions.length > 0 ? linkedSessions : undefined,
  };

  return c.json(response);
});

export { sessions };
