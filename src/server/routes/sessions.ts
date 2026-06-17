import { Hono } from 'hono';
import type {
  Session,
  SessionSummary,
  SessionListResponse,
  SessionDetailResponse,
  SessionStats,
  InternalToolCall,
  Invocation,
  AgentRelationship,
  TokenBudget,
} from '../../shared/types.js';
import { costBreakdown, contextWindowFor } from '../../shared/cost.js';
import { getSession, listSessions, listProjects, getAgentRelationships, getAllAgentToolCalls, getAllAgentTokenTimelines, getLinkedSessions } from '../../db/queries/sessions.js';
import { getTokenTimeline, getMiniTimeline, getMiniTimelinesForSessions, getTurnCountsForSessions, getMessageMatchesForSessions, getEventCountBySession, getTokenTimelineAnnotations } from '../../db/queries/events.js';
import { getSessionStats, getToolFrequency, getFileActivity, getPeakParentTokens, getPeakParentTokensForSessions } from '../../db/queries/stats.js';
import type { SessionFilters } from '../../db/queries/sessions.js';
import type { MessageMatch } from '../../shared/types.js';
import { analyzeCompactions } from '../../analysis/compaction-analysis.js';

const sessions = new Hono();

function parseInvocations(raw: string | null): Invocation[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter(
      (x): x is Invocation =>
        x && (x.type === 'command' || x.type === 'skill') && typeof x.name === 'string',
    );
  } catch {
    return undefined;
  }
}

function parseStartedWith(raw: string | null): Invocation | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.type === 'command' || parsed.type === 'skill') && typeof parsed.name === 'string') {
      return parsed as Invocation;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sessionToSummary(
  session: Session,
  miniTimeline?: import('../../shared/types.js').MiniTimelinePoint[],
  peakTokens?: number,
  turnCount?: number,
  messageMatch?: MessageMatch,
): SessionSummary {
  return {
    id: session.id,
    project_name: session.project_name ?? 'unknown',
    project_path: session.project_path ?? undefined,
    model: session.model ?? 'unknown',
    models_used: session.models_used ? JSON.parse(session.models_used) : undefined,
    status: session.status,
    started_at: session.started_at,
    duration_ms: session.duration_ms ?? 0,
    total_input_tokens: session.total_input_tokens,
    total_output_tokens: session.total_output_tokens,
    total_cache_read_tokens: session.total_cache_read_tokens ?? 0,
    total_cache_write_tokens: session.total_cache_write_tokens ?? 0,
    peak_context_pct: session.peak_context_pct ?? 0,
    peak_tokens: peakTokens ?? 0,
    compaction_count: session.compaction_count,
    tool_call_count: session.tool_call_count,
    subagent_count: session.subagent_count,
    turn_count: turnCount ?? 0,
    summary: session.summary ?? '',
    cost_estimate_usd: session.cost_estimate_usd ?? undefined,
    mini_timeline: miniTimeline ?? [],
    invocations: parseInvocations(session.invocations),
    started_with: parseStartedWith(session.started_with),
    message_match: messageMatch,
  };
}

function round6(x: number): number {
  return Math.round(x * 1_000_000) / 1_000_000;
}

/**
 * Build the per-session `token_budget` breakdown (parent vs. sub-agent split,
 * per-token-type usage, and peak context) from stored session columns and the
 * raw agent_relationships rows. Mirrors the cost assembly in
 * transcript-importer.ts / migrations.ts: parent output is de-inflated by the
 * merged sub-agent output, and the residual cache-write bucket is folded into
 * the 5m bucket (same rate for every model). When a model is unresolvable, the
 * cost for that term is 0 while token counts stay real (Behavior #9).
 */
function assembleTokenBudget(
  session: Session,
  agents: AgentRelationship[],
  peakParentTokens: number | null | undefined,
): TokenBudget {
  // Undo the import-time agent-merge inflation of total_output_tokens.
  const mergedAgentOutput = agents.reduce(
    (sum, a) => sum + (a.input_tokens_total != null ? a.output_tokens_total ?? 0 : 0),
    0,
  );

  const cw5m = session.total_cache_write_5m_tokens;
  const cw1h = session.total_cache_write_1h_tokens;
  const parentParts = {
    freshInput: session.total_input_tokens_billed,
    cacheRead: session.total_cache_read_tokens,
    cacheWrite5m: cw5m,
    cacheWrite1h: cw1h,
    cacheWriteDefault: Math.max(0, session.total_cache_write_tokens - cw5m - cw1h),
    output: Math.max(0, session.total_output_tokens - mergedAgentOutput),
  };

  // Each term: its token `parts` plus the per-type cost atoms from costBreakdown.
  // An unresolvable model yields an all-zero perType (cost 0), real tokens.
  type Parts = {
    freshInput: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    cacheWriteDefault: number;
    output: number;
  };
  const zeroPerType = {
    freshInput: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheWriteDefault: 0,
    output: 0,
  };

  function term(model: string | null | undefined, parts: Parts) {
    const perType = costBreakdown(model, parts)?.perType ?? zeroPerType;
    return { parts, perType };
  }

  const parentTerm = term(session.model, parentParts);
  const agentTerms = agents.map((a) =>
    term(a.model ?? session.model, {
      freshInput: a.input_tokens_total ?? 0,
      cacheRead: a.cache_read_total ?? 0,
      cacheWrite5m: a.cache_write_5m_total ?? 0,
      cacheWrite1h: a.cache_write_1h_total ?? 0,
      cacheWriteDefault: 0,
      output: a.output_tokens_total ?? 0,
    }),
  );

  const allTerms = [parentTerm, ...agentTerms];

  // Five fixed-order buckets, aggregated across the parent + every agent term.
  const buckets = {
    input: { tokens: 0, cost: 0 },
    output: { tokens: 0, cost: 0 },
    cache_read: { tokens: 0, cost: 0 },
    cache_write_5m: { tokens: 0, cost: 0 },
    cache_write_1h: { tokens: 0, cost: 0 },
  };
  for (const { parts, perType } of allTerms) {
    buckets.input.tokens += parts.freshInput;
    buckets.input.cost += perType.freshInput;
    buckets.output.tokens += parts.output;
    buckets.output.cost += perType.output;
    buckets.cache_read.tokens += parts.cacheRead;
    buckets.cache_read.cost += perType.cacheRead;
    buckets.cache_write_5m.tokens += parts.cacheWrite5m + parts.cacheWriteDefault;
    buckets.cache_write_5m.cost += perType.cacheWrite5m + perType.cacheWriteDefault;
    buckets.cache_write_1h.tokens += parts.cacheWrite1h;
    buckets.cache_write_1h.cost += perType.cacheWrite1h;
  }

  const by_type = [
    { type: 'input' as const, tokens: buckets.input.tokens, cost: round6(buckets.input.cost) },
    { type: 'output' as const, tokens: buckets.output.tokens, cost: round6(buckets.output.cost) },
    { type: 'cache_read' as const, tokens: buckets.cache_read.tokens, cost: round6(buckets.cache_read.cost) },
    { type: 'cache_write_5m' as const, tokens: buckets.cache_write_5m.tokens, cost: round6(buckets.cache_write_5m.cost) },
    { type: 'cache_write_1h' as const, tokens: buckets.cache_write_1h.tokens, cost: round6(buckets.cache_write_1h.cost) },
  ];

  const billed_tokens = by_type.reduce((s, b) => s + b.tokens, 0);
  const cost_total = round6(by_type.reduce((s, b) => s + b.cost, 0));

  function termTokens(parts: Parts): number {
    return (
      parts.freshInput +
      parts.cacheRead +
      parts.cacheWrite5m +
      parts.cacheWrite1h +
      parts.cacheWriteDefault +
      parts.output
    );
  }
  function termCost(perType: typeof zeroPerType): number {
    return (
      perType.freshInput +
      perType.cacheRead +
      perType.cacheWrite5m +
      perType.cacheWrite1h +
      perType.cacheWriteDefault +
      perType.output
    );
  }

  const parentTokens = termTokens(parentTerm.parts);
  const parentCost = round6(termCost(parentTerm.perType));
  const agentsTokens = agentTerms.reduce((s, t) => s + termTokens(t.parts), 0);
  const agentsCost = round6(agentTerms.reduce((s, t) => s + termCost(t.perType), 0));

  const parentPct = billed_tokens > 0 ? Math.round((parentTokens / billed_tokens) * 100) : 0;
  const agentsPct = billed_tokens > 0 ? 100 - parentPct : 0;

  return {
    billed_tokens,
    cost_total,
    parent: { tokens: parentTokens, cost: parentCost, pct: parentPct },
    agents: { tokens: agentsTokens, cost: agentsCost, runs: agents.length, pct: agentsPct },
    by_type,
    context_peak: {
      pct: session.peak_context_pct ?? 0,
      peak_tokens: peakParentTokens ?? 0,
      max_tokens: contextWindowFor(session.model) ?? 200_000,
    },
  };
}

sessions.get('/api/projects', (c) => {
  const projects = listProjects();
  return c.json({ projects });
});

sessions.get('/api/sessions', (c) => {
  const q = c.req.query.bind(c.req);

  const filters: SessionFilters = {};
  if (q('project_path')) filters.projectExact = q('project_path');
  else if (q('project')) filters.project = q('project');
  if (q('status')) filters.status = q('status');
  if (q('model')) filters.model = q('model');
  if (q('since')) filters.since = q('since');
  if (q('until')) filters.until = q('until');
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

  const { sessions: rows, total, ftsMatch } = listSessions(filters);

  // Batch-fetch mini timelines and peak parent tokens for all sessions
  const sessionIds = rows.map((s) => s.id);
  const miniTimelines = getMiniTimelinesForSessions(sessionIds);
  const peakTokensBySession = getPeakParentTokensForSessions(sessionIds);
  const turnCountsBySession = getTurnCountsForSessions(sessionIds);

  // Message-content search hits (issue #67). `ftsMatch` is computed once by
  // listSessions and reused here — non-null only when the query has a
  // searchable term; a content match surfaces a highlighted snippet on the row.
  const messageMatches = ftsMatch
    ? getMessageMatchesForSessions(sessionIds, ftsMatch)
    : new Map<string, MessageMatch>();

  const response: SessionListResponse = {
    sessions: rows.map((s) => sessionToSummary(s, miniTimelines.get(s.id), peakTokensBySession.get(s.id), turnCountsBySession.get(s.id), messageMatches.get(s.id))),
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
  const eventAnnotations = getTokenTimelineAnnotations(id);
  const agents = getAgentRelationships(id);
  const stats = getSessionStats(id);
  const toolFreq = getToolFrequency(id);

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
  // Batch-fetch all tool calls and timelines in 2 queries instead of 2*N
  const allToolCalls = getAllAgentToolCalls(id);
  const allAgentTimelines = getAllAgentTokenTimelines(id);

  const agentsWithTools = agents.map((agent) => {
    const toolCalls = allToolCalls.get(agent.child_agent_id) ?? [];
    const internalToolCalls: InternalToolCall[] = toolCalls.map((tc) => ({
      tool_name: tc.tool_name,
      file_path: tc.file_path ?? undefined,
      duration_ms: tc.duration_ms ?? undefined,
      result_char_count: tc.result_char_count ?? undefined,
      estimated_tokens: tc.result_char_count != null ? Math.round(tc.result_char_count / 4) : undefined,
      input_preview: tc.input_preview ?? undefined,
      result_preview: tc.result_preview ?? undefined,
    }));
    const agentTimeline = allAgentTimelines.get(agent.child_agent_id) ?? [];
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

  // Badge should match the Timeline's default landing view, which is parent-only
  // when the session has sub-agents (Timeline.tsx hasAgents check). Mirror it here.
  const eventCount = getEventCountBySession(id, agents.length > 0);
  const linkedSessions = getLinkedSessions(id);

  // File activity + peak parent tokens for Context tab
  const compactionTimestamps = compactionDetails.map(cd => cd.timestamp);
  const fileActivity = getFileActivity(id, compactionTimestamps);
  const peakParentTokens = getPeakParentTokens(id);

  const response: SessionDetailResponse = {
    session,
    token_timeline: tokenTimeline,
    agents: agentsWithTools,
    stats: sessionStats,
    compaction_details: compactionDetails,
    event_count: eventCount,
    agent_efficiency: agentEfficiency,
    linked_sessions: linkedSessions.length > 0 ? linkedSessions : undefined,
    file_activity: fileActivity,
    peak_parent_tokens: peakParentTokens ?? undefined,
    event_annotations: eventAnnotations.length > 0 ? eventAnnotations : undefined,
    token_budget: assembleTokenBudget(session, agents, peakParentTokens),
  };

  return c.json(response);
});

export { sessions };
