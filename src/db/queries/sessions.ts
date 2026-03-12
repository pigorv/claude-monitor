import type { Session, AgentRelationship, TokenDataPoint, LinkedSession } from '../../shared/types.js';
import { getDb } from '../connection.js';

export function insertSession(session: Session): void {
  const db = getDb();
  db.prepare(`
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
  `).run(session);
}

export function upsertSession(session: Session): void {
  const db = getDb();
  db.prepare(`
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
  `).run(session);
}

export function getSession(id: string): Session | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
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
    conditions.push('(project_name LIKE @q OR project_path LIKE @q OR summary LIKE @q)');
    params.q = `%${filters.q}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM sessions ${where}`).get(params) as { total: number };

  const sortCol = filters.sort && ALLOWED_SORT_COLUMNS.has(filters.sort) ? filters.sort : 'started_at';
  const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const sessions = db.prepare(
    `SELECT * FROM sessions ${where} ORDER BY ${sortCol} ${sortOrder} LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as Session[];

  return { sessions, total: countRow.total };
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
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function sessionExists(id: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
  return row !== undefined;
}

export function getAgentRelationships(sessionId: string): AgentRelationship[] {
  const db = getDb();
  return db.prepare('SELECT * FROM agent_relationships WHERE parent_session_id = ?').all(sessionId) as AgentRelationship[];
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
  return db.prepare(`
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
  `).all(sessionId, agentId) as TokenDataPoint[];
}

// ── Session linking ─────────────────────────────────────────────────

export function insertSessionLink(sourceId: string, targetId: string, linkType: string = 'plan_implementation'): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO session_links (source_session_id, target_session_id, link_type)
    VALUES (?, ?, ?)
  `).run(sourceId, targetId, linkType);
}

export function getLinkedSessions(sessionId: string): LinkedSession[] {
  const db = getDb();
  const rows = db.prepare(`
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
    JOIN sessions s ON s.id = CASE
      WHEN sl.source_session_id = ? THEN sl.target_session_id
      ELSE sl.source_session_id
    END
    WHERE sl.source_session_id = ? OR sl.target_session_id = ?
  `).all(sessionId, sessionId, sessionId) as Array<{
    link_type: string;
    source_session_id: string;
    target_session_id: string;
    session_id: string;
    project_name: string | null;
    model: string | null;
    started_at: string;
    duration_ms: number | null;
    summary: string | null;
  }>;

  return rows.map((row) => ({
    session_id: row.session_id,
    project_name: row.project_name,
    model: row.model,
    started_at: row.started_at,
    duration_ms: row.duration_ms,
    summary: row.summary,
    // If this session is the source (plan), the linked session is the implementation, and vice versa
    relationship: row.source_session_id === sessionId
      ? 'implementation_session' as const
      : 'planning_session' as const,
  }));
}

export function getAgentToolCalls(sessionId: string, agentId: string): AgentToolCallRow[] {
  const db = getDb();
  return db.prepare(`
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
  `).all(sessionId, agentId) as AgentToolCallRow[];
}
