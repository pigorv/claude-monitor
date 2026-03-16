import type Database from 'better-sqlite3';
import type { Event, TokenDataPoint, MiniTimelinePoint } from '../../shared/types.js';
import { getDb, onDbClose } from '../connection.js';

// ── Cached prepared statements ──────────────────────────────────────
let _insertEventStmt: Database.Statement | null = null;
let _getEventStmt: Database.Statement | null = null;
let _tokenTimelineStmt: Database.Statement | null = null;
let _miniTimelineStmt: Database.Statement | null = null;
let _deleteEventsBySessionStmt: Database.Statement | null = null;
let _eventCountBySessionStmt: Database.Statement | null = null;

onDbClose(() => {
  _insertEventStmt = _getEventStmt = _tokenTimelineStmt = _miniTimelineStmt =
    _deleteEventsBySessionStmt = _eventCountBySessionStmt = null;
});

export function insertEvent(event: Omit<Event, 'id'>): number {
  const db = getDb();
  _insertEventStmt ??= db.prepare(`
    INSERT INTO events (
      session_id, parent_event_id, agent_id, event_type, event_source, tool_name,
      timestamp, sequence_num, input_tokens, output_tokens, cache_read_tokens,
      context_pct, input_preview, input_data, output_preview, output_data,
      thinking_summary, thinking_text, duration_ms, metadata
    ) VALUES (
      @session_id, @parent_event_id, @agent_id, @event_type, @event_source, @tool_name,
      @timestamp, @sequence_num, @input_tokens, @output_tokens, @cache_read_tokens,
      @context_pct, @input_preview, @input_data, @output_preview, @output_data,
      @thinking_summary, @thinking_text, @duration_ms, @metadata
    )
  `);
  const result = _insertEventStmt.run(event);
  return Number(result.lastInsertRowid);
}

export function insertEvents(events: Omit<Event, 'id'>[]): number[] {
  const db = getDb();
  const ids: number[] = [];
  // insertEvent's cached stmt is reused inside the transaction
  const stmt = _insertEventStmt ?? db.prepare(`
    INSERT INTO events (
      session_id, parent_event_id, agent_id, event_type, event_source, tool_name,
      timestamp, sequence_num, input_tokens, output_tokens, cache_read_tokens,
      context_pct, input_preview, input_data, output_preview, output_data,
      thinking_summary, thinking_text, duration_ms, metadata
    ) VALUES (
      @session_id, @parent_event_id, @agent_id, @event_type, @event_source, @tool_name,
      @timestamp, @sequence_num, @input_tokens, @output_tokens, @cache_read_tokens,
      @context_pct, @input_preview, @input_data, @output_preview, @output_data,
      @thinking_summary, @thinking_text, @duration_ms, @metadata
    )
  `);
  _insertEventStmt ??= stmt;

  db.transaction(() => {
    for (const event of events) {
      const result = stmt.run(event);
      ids.push(Number(result.lastInsertRowid));
    }
  })();

  return ids;
}

export function getEvent(id: number): Event | undefined {
  const db = getDb();
  _getEventStmt ??= db.prepare('SELECT * FROM events WHERE id = ?');
  return _getEventStmt.get(id) as Event | undefined;
}

export interface EventFilters {
  eventType?: string;
  toolName?: string;
  agentId?: string;
  parentOnly?: boolean;
  includeThinking?: boolean;
  limit?: number;
  offset?: number;
}

export function listEventsBySession(
  sessionId: string,
  filters: EventFilters = {},
): { events: Event[]; total: number } {
  // Dynamic query — can't cache since SQL varies by filters
  const db = getDb();
  const conditions: string[] = ['session_id = @sessionId'];
  const params: Record<string, unknown> = { sessionId };

  if (filters.eventType) {
    conditions.push('event_type = @eventType');
    params.eventType = filters.eventType;
  }
  if (filters.toolName) {
    conditions.push('tool_name = @toolName');
    params.toolName = filters.toolName;
  }
  if (filters.agentId) {
    conditions.push('agent_id = @agentId');
    params.agentId = filters.agentId;
  }
  if (filters.parentOnly) {
    conditions.push('agent_id IS NULL');
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const columns = filters.includeThinking
    ? '*'
    : 'id, session_id, parent_event_id, agent_id, event_type, event_source, tool_name, timestamp, sequence_num, input_tokens, output_tokens, cache_read_tokens, context_pct, input_preview, input_data, output_preview, output_data, thinking_summary, duration_ms, metadata';

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  // Single query with window function to get total + rows in one pass
  const rows = db.prepare(
    `SELECT ${columns}, COUNT(*) OVER() as _total FROM events ${where} ORDER BY timestamp ASC, CASE WHEN agent_id IS NULL THEN 0 ELSE 1 END, sequence_num ASC LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as (Event & { _total: number })[];

  const total = rows.length > 0 ? rows[0]._total : 0;

  return { events: rows, total };
}

export function getTokenTimeline(sessionId: string): TokenDataPoint[] {
  const db = getDb();
  _tokenTimelineStmt ??= db.prepare(`
    SELECT
      timestamp,
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      COALESCE(cache_read_tokens, 0) as cache_read_tokens,
      COALESCE(context_pct, 0) as context_pct,
      event_type,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id = ? AND input_tokens IS NOT NULL
    ORDER BY sequence_num ASC, timestamp ASC
  `);
  return _tokenTimelineStmt.all(sessionId) as TokenDataPoint[];
}

export function getMiniTimeline(sessionId: string, maxPoints: number = 20): MiniTimelinePoint[] {
  const db = getDb();
  _miniTimelineStmt ??= db.prepare(`
    SELECT
      COALESCE(context_pct, 0) as context_pct,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id = ? AND context_pct IS NOT NULL
    ORDER BY sequence_num ASC, timestamp ASC
  `);
  const rows = _miniTimelineStmt.all(sessionId) as { context_pct: number; is_compaction: number }[];

  if (rows.length <= maxPoints) {
    return rows.map((r) => ({ context_pct: r.context_pct, is_compaction: r.is_compaction === 1 }));
  }

  // Downsample but preserve compaction events
  const compactionIndices = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].is_compaction === 1) compactionIndices.add(i);
  }

  const sampledIndices = new Set<number>(compactionIndices);
  const remaining = maxPoints - sampledIndices.size;
  if (remaining > 0) {
    const step = rows.length / remaining;
    for (let i = 0; i < remaining; i++) {
      const idx = Math.min(Math.floor(i * step), rows.length - 1);
      sampledIndices.add(idx);
    }
  }

  const sortedIndices = Array.from(sampledIndices).sort((a, b) => a - b);
  return sortedIndices.map((i) => ({
    context_pct: rows[i].context_pct,
    is_compaction: rows[i].is_compaction === 1,
  }));
}

export function deleteEventsBySession(sessionId: string): number {
  const db = getDb();
  _deleteEventsBySessionStmt ??= db.prepare('DELETE FROM events WHERE session_id = ?');
  const result = _deleteEventsBySessionStmt.run(sessionId);
  return result.changes;
}

/**
 * Batch-fetch mini timelines for multiple sessions in a single query.
 * Returns a map of sessionId → MiniTimelinePoint[].
 */
export function getMiniTimelinesForSessions(sessionIds: string[], maxPoints: number = 20): Map<string, MiniTimelinePoint[]> {
  if (sessionIds.length === 0) return new Map();

  const db = getDb();
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT
      session_id,
      COALESCE(context_pct, 0) as context_pct,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id IN (${placeholders}) AND context_pct IS NOT NULL
    ORDER BY session_id, sequence_num ASC, timestamp ASC
  `).all(...sessionIds) as { session_id: string; context_pct: number; is_compaction: number }[];

  // Group by session
  const grouped = new Map<string, { context_pct: number; is_compaction: number }[]>();
  for (const row of rows) {
    let list = grouped.get(row.session_id);
    if (!list) {
      list = [];
      grouped.set(row.session_id, list);
    }
    list.push({ context_pct: row.context_pct, is_compaction: row.is_compaction });
  }

  // Downsample each session's timeline
  const result = new Map<string, MiniTimelinePoint[]>();
  for (const [sid, sessionRows] of grouped) {
    if (sessionRows.length <= maxPoints) {
      result.set(sid, sessionRows.map((r) => ({ context_pct: r.context_pct, is_compaction: r.is_compaction === 1 })));
      continue;
    }

    const compactionIndices = new Set<number>();
    for (let i = 0; i < sessionRows.length; i++) {
      if (sessionRows[i].is_compaction === 1) compactionIndices.add(i);
    }
    const sampledIndices = new Set<number>(compactionIndices);
    const remaining = maxPoints - sampledIndices.size;
    if (remaining > 0) {
      const step = sessionRows.length / remaining;
      for (let i = 0; i < remaining; i++) {
        sampledIndices.add(Math.min(Math.floor(i * step), sessionRows.length - 1));
      }
    }
    const sorted = Array.from(sampledIndices).sort((a, b) => a - b);
    result.set(sid, sorted.map((i) => ({
      context_pct: sessionRows[i].context_pct,
      is_compaction: sessionRows[i].is_compaction === 1,
    })));
  }

  // Ensure all requested sessions have an entry (even if empty)
  for (const sid of sessionIds) {
    if (!result.has(sid)) result.set(sid, []);
  }

  return result;
}

export function getEventCountBySession(sessionId: string): number {
  const db = getDb();
  _eventCountBySessionStmt ??= db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?');
  const row = _eventCountBySessionStmt.get(sessionId) as { count: number };
  return row.count;
}
