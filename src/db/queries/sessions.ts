import type Database from 'better-sqlite3';
import type { Session, AgentRelationship, TokenDataPoint, LinkedSession } from '../../shared/types.js';
import { getDb, onDbClose } from '../connection.js';

// ── Cached prepared statements ──────────────────────────────────────
let _insertSessionStmt: Database.Statement | null = null;
let _upsertSessionStmt: Database.Statement | null = null;
let _getSessionStmt: Database.Statement | null = null;
let _deleteSessionStmt: Database.Statement | null = null;
let _sessionExistsStmt: Database.Statement | null = null;
let _getAgentRelStmt: Database.Statement | null = null;
let _agentTokenTimelineStmt: Database.Statement | null = null;
let _allAgentTokenTimelinesStmt: Database.Statement | null = null;
let _insertSessionLinkStmt: Database.Statement | null = null;
let _getLinkedSourceStmt: Database.Statement | null = null;
let _getLinkedTargetStmt: Database.Statement | null = null;
let _agentToolCallsStmt: Database.Statement | null = null;
let _allAgentToolCallsStmt: Database.Statement | null = null;

onDbClose(() => {
  _insertSessionStmt = _upsertSessionStmt = _getSessionStmt = _deleteSessionStmt =
    _sessionExistsStmt = _getAgentRelStmt = _agentTokenTimelineStmt =
    _allAgentTokenTimelinesStmt = _insertSessionLinkStmt = _getLinkedSourceStmt =
    _getLinkedTargetStmt = _agentToolCallsStmt = _allAgentToolCallsStmt = null;
});

export function insertSession(session: Session): void {
  const db = getDb();
  _insertSessionStmt ??= db.prepare(`
    INSERT INTO sessions (
      id, project_path, project_name, model, source, status, started_at, ended_at,
      duration_ms, total_input_tokens, total_output_tokens, total_cache_read_tokens,
      total_cache_write_tokens, peak_context_pct, compaction_count, tool_call_count,
      subagent_count, risk_score, summary, end_reason, transcript_path, metadata
    ) VALUES (
      @id, @project_path, @project_name, @model, @source, @status, @started_at, @ended_at,
      @duration_ms, @total_input_tokens, @total_output_tokens, @total_cache_read_tokens,
      @total_cache_write_tokens, @peak_context_pct, @compaction_count, @tool_call_count,
      @subagent_count, @risk_score, @summary, @end_reason, @transcript_path, @metadata
    )
  `);
  _insertSessionStmt.run(session);
}

export function upsertSession(session: Session): void {
  const db = getDb();
  _upsertSessionStmt ??= db.prepare(`
    INSERT INTO sessions (
      id, project_path, project_name, model, source, status, started_at, ended_at,
      duration_ms, total_input_tokens, total_output_tokens, total_cache_read_tokens,
      total_cache_write_tokens, peak_context_pct, compaction_count, tool_call_count,
      subagent_count, risk_score, summary, end_reason, transcript_path, metadata
    ) VALUES (
      @id, @project_path, @project_name, @model, @source, @status, @started_at, @ended_at,
      @duration_ms, @total_input_tokens, @total_output_tokens, @total_cache_read_tokens,
      @total_cache_write_tokens, @peak_context_pct, @compaction_count, @tool_call_count,
      @subagent_count, @risk_score, @summary, @end_reason, @transcript_path, @metadata
    )
    ON CONFLICT(id) DO UPDATE SET
      project_path = excluded.project_path,
      project_name = excluded.project_name,
      model = COALESCE(excluded.model, model),
      source = COALESCE(excluded.source, source),
      status = excluded.status,
      started_at = excluded.started_at,
      ended_at = COALESCE(excluded.ended_at, ended_at),
      duration_ms = COALESCE(excluded.duration_ms, duration_ms),
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cache_write_tokens = excluded.total_cache_write_tokens,
      peak_context_pct = COALESCE(excluded.peak_context_pct, peak_context_pct),
      compaction_count = excluded.compaction_count,
      tool_call_count = excluded.tool_call_count,
      subagent_count = excluded.subagent_count,
      risk_score = COALESCE(excluded.risk_score, risk_score),
      summary = COALESCE(excluded.summary, summary),
      end_reason = COALESCE(excluded.end_reason, end_reason),
      transcript_path = COALESCE(excluded.transcript_path, transcript_path),
      metadata = COALESCE(excluded.metadata, metadata)
  `);
  _upsertSessionStmt.run(session);
}

export function getSession(id: string): Session | undefined {
  const db = getDb();
  _getSessionStmt ??= db.prepare('SELECT * FROM sessions WHERE id = ?');
  return _getSessionStmt.get(id) as Session | undefined;
}

export interface SessionFilters {
  project?: string;
  status?: string;
  model?: string;
  since?: string;
  until?: string;
  minRisk?: number;
  q?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const ALLOWED_SORT_COLUMNS = new Set([
  'started_at', 'duration_ms', 'risk_score', 'total_input_tokens',
  'compaction_count', 'tool_call_count', 'subagent_count',
]);

/** Columns needed by sessionToSummary() — excludes large TEXT fields like metadata */
const SESSION_LIST_COLUMNS = `
  id, project_path, project_name, model, source, status, started_at, ended_at,
  duration_ms, total_input_tokens, total_output_tokens, total_cache_read_tokens,
  total_cache_write_tokens, peak_context_pct, compaction_count, tool_call_count,
  subagent_count, risk_score, summary, end_reason, transcript_path
`;

export function listSessions(filters: SessionFilters = {}): { sessions: Session[]; total: number } {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.project) {
    conditions.push('project_path LIKE @project');
    params.project = `%${filters.project}%`;
  }
  if (filters.status) {
    conditions.push('status = @status');
    params.status = filters.status;
  }
  if (filters.model) {
    conditions.push('model LIKE @model');
    params.model = `%${filters.model}%`;
  }
  if (filters.since) {
    conditions.push('started_at >= @since');
    params.since = filters.since;
  }
  if (filters.until) {
    conditions.push('started_at <= @until');
    params.until = filters.until;
  }
  if (filters.minRisk !== undefined) {
    conditions.push('risk_score >= @minRisk');
    params.minRisk = filters.minRisk;
  }
  if (filters.q) {
    // LIKE with leading % cannot use indexes — acceptable for <10K sessions
    conditions.push('(project_name LIKE @q OR project_path LIKE @q OR summary LIKE @q)');
    params.q = `%${filters.q}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sortCol = filters.sort && ALLOWED_SORT_COLUMNS.has(filters.sort) ? filters.sort : 'started_at';
  const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  // Single query with window function to get total count + paginated rows in one pass
  const rows = db.prepare(
    `SELECT ${SESSION_LIST_COLUMNS}, COUNT(*) OVER() as _total FROM sessions ${where} ORDER BY ${sortCol} ${sortOrder} LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as (Session & { _total: number })[];

  const total = rows.length > 0 ? rows[0]._total : 0;

  return { sessions: rows, total };
}

export function updateSession(id: string, updates: Partial<Omit<Session, 'id'>>): void {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = @${key}`);
    params[key] = value;
  }

  if (setClauses.length === 0) return;

  db.prepare(`UPDATE sessions SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
}

export function deleteSession(id: string): void {
  const db = getDb();
  _deleteSessionStmt ??= db.prepare('DELETE FROM sessions WHERE id = ?');
  _deleteSessionStmt.run(id);
}

export function sessionExists(id: string): boolean {
  const db = getDb();
  _sessionExistsStmt ??= db.prepare('SELECT 1 FROM sessions WHERE id = ?');
  const row = _sessionExistsStmt.get(id);
  return row !== undefined;
}

export function getAgentRelationships(sessionId: string): AgentRelationship[] {
  const db = getDb();
  // Exclude prompt_data and result_data — large JSON blobs not needed by the route
  _getAgentRelStmt ??= db.prepare(`
    SELECT
      id, parent_session_id, child_agent_id, child_transcript_path,
      prompt_preview, result_preview, started_at, ended_at,
      duration_ms, input_tokens_total, output_tokens_total,
      tool_call_count, status, prompt_tokens, result_tokens,
      peak_context_tokens, compression_ratio, agent_compaction_count,
      parent_headroom_at_return, parent_impact_pct, result_classification,
      execution_mode, files_read_count, files_total_tokens,
      spawn_timestamp, complete_timestamp
    FROM agent_relationships WHERE parent_session_id = ?
  `);
  return _getAgentRelStmt.all(sessionId) as AgentRelationship[];
}

export interface AgentToolCallRow {
  tool_name: string;
  file_path: string | null;
  duration_ms: number | null;
  result_char_count: number | null;
  input_preview: string | null;
  result_preview: string | null;
}

export function updateAgentRelationship(
  parentSessionId: string,
  childAgentId: string,
  updates: Partial<Omit<AgentRelationship, 'id' | 'parent_session_id' | 'child_agent_id'>>,
): void {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, unknown> = { parentSessionId, childAgentId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = @${key}`);
      params[key] = value;
    }
  }

  if (setClauses.length === 0) return;

  db.prepare(
    `UPDATE agent_relationships SET ${setClauses.join(', ')} WHERE parent_session_id = @parentSessionId AND child_agent_id = @childAgentId`,
  ).run(params);
}

export function getAgentTokenTimeline(sessionId: string, agentId: string): TokenDataPoint[] {
  const db = getDb();
  _agentTokenTimelineStmt ??= db.prepare(`
    SELECT
      timestamp,
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      COALESCE(cache_read_tokens, 0) as cache_read_tokens,
      COALESCE(context_pct, 0) as context_pct,
      event_type,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id = ? AND agent_id = ? AND input_tokens IS NOT NULL
    ORDER BY sequence_num ASC, timestamp ASC
  `);
  return _agentTokenTimelineStmt.all(sessionId, agentId) as TokenDataPoint[];
}

export function getAllAgentTokenTimelines(sessionId: string): Map<string, TokenDataPoint[]> {
  const db = getDb();
  _allAgentTokenTimelinesStmt ??= db.prepare(`
    SELECT
      agent_id,
      timestamp,
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      COALESCE(cache_read_tokens, 0) as cache_read_tokens,
      COALESCE(context_pct, 0) as context_pct,
      event_type,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id = ? AND agent_id IS NOT NULL AND input_tokens IS NOT NULL
    ORDER BY agent_id, sequence_num ASC, timestamp ASC
  `);
  const rows = _allAgentTokenTimelinesStmt.all(sessionId) as (TokenDataPoint & { agent_id: string })[];

  const map = new Map<string, TokenDataPoint[]>();
  for (const row of rows) {
    const agentId = row.agent_id;
    let list = map.get(agentId);
    if (!list) {
      list = [];
      map.set(agentId, list);
    }
    list.push(row);
  }
  return map;
}

// ── Session linking ─────────────────────────────────────────────────

export function insertSessionLink(sourceId: string, targetId: string, linkType: string = 'plan_implementation'): void {
  const db = getDb();
  _insertSessionLinkStmt ??= db.prepare(`
    INSERT OR IGNORE INTO session_links (source_session_id, target_session_id, link_type)
    VALUES (?, ?, ?)
  `);
  _insertSessionLinkStmt.run(sourceId, targetId, linkType);
}

export function getLinkedSessions(sessionId: string): LinkedSession[] {
  const db = getDb();

  // Use UNION ALL so each branch can use its respective index
  _getLinkedSourceStmt ??= db.prepare(`
    SELECT
      sl.link_type,
      sl.source_session_id,
      sl.target_session_id,
      s.id as session_id,
      s.project_name,
      s.model,
      s.started_at,
      s.duration_ms,
      s.summary
    FROM session_links sl
    JOIN sessions s ON s.id = sl.target_session_id
    WHERE sl.source_session_id = ?
  `);
  _getLinkedTargetStmt ??= db.prepare(`
    SELECT
      sl.link_type,
      sl.source_session_id,
      sl.target_session_id,
      s.id as session_id,
      s.project_name,
      s.model,
      s.started_at,
      s.duration_ms,
      s.summary
    FROM session_links sl
    JOIN sessions s ON s.id = sl.source_session_id
    WHERE sl.target_session_id = ?
  `);

  type LinkedRow = {
    link_type: string;
    source_session_id: string;
    target_session_id: string;
    session_id: string;
    project_name: string | null;
    model: string | null;
    started_at: string;
    duration_ms: number | null;
    summary: string | null;
  };

  const sourceRows = _getLinkedSourceStmt.all(sessionId) as LinkedRow[];
  const targetRows = _getLinkedTargetStmt.all(sessionId) as LinkedRow[];

  const mapRow = (row: LinkedRow): LinkedSession => ({
    session_id: row.session_id,
    project_name: row.project_name,
    model: row.model,
    started_at: row.started_at,
    duration_ms: row.duration_ms,
    summary: row.summary,
    relationship: row.source_session_id === sessionId
      ? 'implementation_session' as const
      : 'planning_session' as const,
  });

  return [...sourceRows.map(mapRow), ...targetRows.map(mapRow)];
}

export function getAgentToolCalls(sessionId: string, agentId: string): AgentToolCallRow[] {
  const db = getDb();
  _agentToolCallsStmt ??= db.prepare(`
    SELECT
      tool_name,
      json_extract(input_data, '$.file_path') as file_path,
      duration_ms,
      length(output_data) as result_char_count,
      substr(input_data, 1, 200) as input_preview,
      substr(output_data, 1, 200) as result_preview
    FROM events
    WHERE session_id = ? AND agent_id = ? AND tool_name IS NOT NULL
    ORDER BY sequence_num ASC, timestamp ASC
  `);
  return _agentToolCallsStmt.all(sessionId, agentId) as AgentToolCallRow[];
}

/**
 * Batch-fetch tool calls for ALL agents in a session in a single query.
 * Returns a map of agentId → AgentToolCallRow[].
 */
export function getAllAgentToolCalls(sessionId: string): Map<string, AgentToolCallRow[]> {
  const db = getDb();
  _allAgentToolCallsStmt ??= db.prepare(`
    SELECT
      agent_id,
      tool_name,
      json_extract(input_data, '$.file_path') as file_path,
      duration_ms,
      length(output_data) as result_char_count,
      substr(input_data, 1, 200) as input_preview,
      substr(output_data, 1, 200) as result_preview
    FROM events
    WHERE session_id = ? AND agent_id IS NOT NULL AND tool_name IS NOT NULL
    ORDER BY agent_id, sequence_num ASC, timestamp ASC
  `);
  const rows = _allAgentToolCallsStmt.all(sessionId) as (AgentToolCallRow & { agent_id: string })[];

  const map = new Map<string, AgentToolCallRow[]>();
  for (const row of rows) {
    let list = map.get(row.agent_id);
    if (!list) {
      list = [];
      map.set(row.agent_id, list);
    }
    list.push(row);
  }
  return map;
}
