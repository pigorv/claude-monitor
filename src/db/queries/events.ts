import type { Event, TokenDataPoint, MiniTimelinePoint } from '../../shared/types.js';
import { getDb } from '../connection.js';

export function insertEvent(event: Omit<Event, 'id'>): number {
  const db = getDb();
  const result = db.prepare(`
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
  `).run(event);
  return Number(result.lastInsertRowid);
}

export function insertEvents(events: Omit<Event, 'id'>[]): number[] {
  const db = getDb();
  const ids: number[] = [];
  const stmt = db.prepare(`
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
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Event | undefined;
}

export interface EventFilters {
  eventType?: string;
  toolName?: string;
  agentId?: string;
  includeThinking?: boolean;
  limit?: number;
  offset?: number;
}

export function listEventsBySession(
  sessionId: string,
  filters: EventFilters = {},
): { events: Event[]; total: number } {
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

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM events ${where}`).get(params) as { total: number };

  const columns = filters.includeThinking
    ? '*'
    : 'id, session_id, parent_event_id, agent_id, event_type, event_source, tool_name, timestamp, sequence_num, input_tokens, output_tokens, cache_read_tokens, context_pct, input_preview, input_data, output_preview, output_data, thinking_summary, duration_ms, metadata';

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const events = db.prepare(
    `SELECT ${columns} FROM events ${where} ORDER BY sequence_num ASC, timestamp ASC LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as Event[];

  return { events, total: countRow.total };
}

export function getTokenTimeline(sessionId: string): TokenDataPoint[] {
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
    WHERE session_id = ? AND input_tokens IS NOT NULL
    ORDER BY sequence_num ASC, timestamp ASC
  `).all(sessionId) as TokenDataPoint[];
}

export function getMiniTimeline(sessionId: string, maxPoints: number = 20): MiniTimelinePoint[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      COALESCE(context_pct, 0) as context_pct,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id = ? AND context_pct IS NOT NULL
    ORDER BY sequence_num ASC, timestamp ASC
  `).all(sessionId) as { context_pct: number; is_compaction: number }[];

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
  const result = db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
  return result.changes;
}

export function getEventCountBySession(sessionId: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?').get(sessionId) as { count: number };
  return row.count;
}
