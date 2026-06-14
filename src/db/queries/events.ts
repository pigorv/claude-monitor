import type Database from 'better-sqlite3';
import type { Event, TokenDataPoint, MiniTimelinePoint, EventAnnotation, MessageMatch } from '../../shared/types.js';
import { getDb, onDbClose } from '../connection.js';
import { SNIPPET_MARK_START, SNIPPET_MARK_END } from '../../shared/search.js';

// ── Cached prepared statements ──────────────────────────────────────
let _insertEventStmt: Database.Statement | null = null;
let _getEventStmt: Database.Statement | null = null;
let _tokenTimelineStmt: Database.Statement | null = null;
let _miniTimelineStmt: Database.Statement | null = null;
let _deleteEventsBySessionStmt: Database.Statement | null = null;
let _eventCountBySessionStmt: Database.Statement | null = null;
let _eventCountParentOnlyStmt: Database.Statement | null = null;
let _annotationEventsStmt: Database.Statement | null = null;
let _eventTypeCountsStmt: Database.Statement | null = null;
let _eventTypeCountsParentOnlyStmt: Database.Statement | null = null;

onDbClose(() => {
  _insertEventStmt = _getEventStmt = _tokenTimelineStmt = _miniTimelineStmt =
    _deleteEventsBySessionStmt = _eventCountBySessionStmt = _eventCountParentOnlyStmt =
    _annotationEventsStmt = _eventTypeCountsStmt = _eventTypeCountsParentOnlyStmt = null;
});

export function insertEvent(event: Omit<Event, 'id'>): number {
  const db = getDb();
  _insertEventStmt ??= db.prepare(`
    INSERT INTO events (
      session_id, agent_id, event_type, event_source, tool_name,
      timestamp, sequence_num, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, context_pct, input_preview, input_data, output_preview, output_data,
      thinking_summary, thinking_text, duration_ms, metadata
    ) VALUES (
      @session_id, @agent_id, @event_type, @event_source, @tool_name,
      @timestamp, @sequence_num, @input_tokens, @output_tokens, @cache_read_tokens,
      @cache_write_tokens, @context_pct, @input_preview, @input_data, @output_preview, @output_data,
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
      session_id, agent_id, event_type, event_source, tool_name,
      timestamp, sequence_num, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, context_pct, input_preview, input_data, output_preview, output_data,
      thinking_summary, thinking_text, duration_ms, metadata
    ) VALUES (
      @session_id, @agent_id, @event_type, @event_source, @tool_name,
      @timestamp, @sequence_num, @input_tokens, @output_tokens, @cache_read_tokens,
      @cache_write_tokens, @context_pct, @input_preview, @input_data, @output_preview, @output_data,
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
    : 'id, session_id, agent_id, event_type, event_source, tool_name, timestamp, sequence_num, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, context_pct, input_preview, input_data, output_preview, output_data, thinking_summary, duration_ms, metadata';

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  // Single query with window function to get total + rows in one pass
  const rows = db.prepare(
    `SELECT ${columns}, COUNT(*) OVER() as _total FROM events ${where} ORDER BY timestamp ASC, CASE WHEN agent_id IS NULL THEN 0 ELSE 1 END, sequence_num ASC LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as (Event & { _total: number })[];

  const total = rows.length > 0 ? rows[0]._total : 0;

  return { events: rows, total };
}

/**
 * Collapse consecutive ordered rows that share an identical token-usage
 * signature into a single kept row.
 *
 * Claude Code streams each assistant message as several JSONL lines
 * (thinking / text / tool_use blocks) that carry IDENTICAL `usage` but
 * timestamps a couple of ms apart, so a per-timestamp GROUP BY no longer
 * collapses them. Walking the ordered rows and starting a new kept point only
 * when the `(input, output, cache_read, cache_write)` 4-tuple changes yields
 * exactly one point per real API turn (each real turn's usage differs from the
 * prior one, so distinct turns — including tool-only turns — are never merged).
 *
 * Within a run, compaction is OR-folded: if any row carries
 * `event_type === 'compaction'` (or a truthy `is_compaction`), the kept point's
 * `event_type` becomes `'compaction'` and `is_compaction` becomes truthy.
 * Otherwise the kept point keeps the FIRST row's field values.
 *
 * Exported so a sibling query file (agent timelines) can reuse it — those rows
 * share the same token fields plus an `event_type`/`is_compaction` column.
 */
export function collapseTimelineByUsage<
  T extends {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    event_type?: string;
    is_compaction?: number | boolean;
  },
>(rows: T[]): T[] {
  const collapsed: T[] = [];
  let prevSig: string | null = null;

  for (const row of rows) {
    const sig =
      `${row.input_tokens ?? 0}|${row.output_tokens ?? 0}|` +
      `${row.cache_read_tokens ?? 0}|${row.cache_write_tokens ?? 0}`;
    const isCompaction = row.event_type === 'compaction' || Boolean(row.is_compaction);

    if (sig !== prevSig) {
      // New run: keep this row (its first member) as the point.
      const kept = { ...row };
      if (isCompaction) {
        if ('event_type' in kept) kept.event_type = 'compaction' as T['event_type'];
        if ('is_compaction' in kept) {
          kept.is_compaction = (typeof kept.is_compaction === 'boolean'
            ? true
            : 1) as T['is_compaction'];
        }
      }
      collapsed.push(kept);
      prevSig = sig;
    } else if (isCompaction) {
      // Continuing run — OR-fold compaction onto the kept point.
      const kept = collapsed[collapsed.length - 1];
      if ('event_type' in kept) kept.event_type = 'compaction' as T['event_type'];
      if ('is_compaction' in kept) {
        kept.is_compaction = (typeof kept.is_compaction === 'boolean'
          ? true
          : 1) as T['is_compaction'];
      }
    }
  }

  return collapsed;
}

export function getTokenTimeline(sessionId: string): TokenDataPoint[] {
  const db = getDb();
  // One point per real API turn. Claude Code streams each assistant message as
  // several JSONL lines (thinking/text/tool_use blocks) that carry identical
  // usage but timestamps ~2 ms apart, so a per-timestamp GROUP BY no longer
  // collapses them. Select raw ordered rows and collapse consecutive rows that
  // share an identical usage signature in JS instead — tool-only turns (which
  // emit tool_call_start but no assistant_message) carry distinct usage and so
  // still contribute their own point.
  _tokenTimelineStmt ??= db.prepare(`
    SELECT
      timestamp,
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      COALESCE(cache_read_tokens, 0) as cache_read_tokens,
      COALESCE(cache_write_tokens, 0) as cache_write_tokens,
      COALESCE(context_pct, 0) as context_pct,
      CASE WHEN event_type = 'compaction' THEN 'compaction' ELSE 'assistant_message' END as event_type,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id = ? AND input_tokens IS NOT NULL AND agent_id IS NULL
      AND event_type IN ('assistant_message', 'compaction', 'tool_call_start')
      AND (COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)) > 0
    ORDER BY sequence_num ASC, timestamp ASC
  `);
  const rows = _tokenTimelineStmt.all(sessionId) as TokenDataPoint[];
  return collapseTimelineByUsage(rows);
}

export function getMiniTimeline(sessionId: string, maxPoints: number = 20): MiniTimelinePoint[] {
  const db = getDb();
  // Same collapse-by-usage treatment as getTokenTimeline: select raw ordered
  // rows (including the four usage columns the helper needs for its signature),
  // collapse consecutive identical-usage runs, then downsample.
  _miniTimelineStmt ??= db.prepare(`
    SELECT
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      COALESCE(cache_read_tokens, 0) as cache_read_tokens,
      COALESCE(cache_write_tokens, 0) as cache_write_tokens,
      COALESCE(context_pct, 0) as context_pct,
      CASE WHEN event_type = 'compaction' THEN 1 ELSE 0 END as is_compaction
    FROM events
    WHERE session_id = ? AND context_pct IS NOT NULL AND agent_id IS NULL
      AND event_type IN ('assistant_message', 'compaction', 'tool_call_start')
      AND (COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) + COALESCE(cache_write_tokens, 0) + COALESCE(output_tokens, 0)) > 0
    ORDER BY sequence_num ASC, timestamp ASC
  `);
  const rawRows = _miniTimelineStmt.all(sessionId) as {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    context_pct: number;
    is_compaction: number;
  }[];
  const rows = collapseTimelineByUsage(rawRows);

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
    WHERE session_id IN (${placeholders}) AND context_pct IS NOT NULL AND agent_id IS NULL
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

/**
 * Batch-fetch user-message ("turn") counts for multiple sessions in a single
 * query. Counts main-session user messages only (agent_id IS NULL) so subagent
 * prompts are excluded. Returns a map of sessionId → turn count (0 if none).
 */
export function getTurnCountsForSessions(sessionIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (sessionIds.length === 0) return result;

  const db = getDb();
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT session_id, COUNT(*) as turn_count
    FROM events
    WHERE session_id IN (${placeholders})
      AND event_type = 'user_message'
      AND agent_id IS NULL
    GROUP BY session_id
  `).all(...sessionIds) as { session_id: string; turn_count: number }[];

  for (const sid of sessionIds) result.set(sid, 0);
  for (const row of rows) result.set(row.session_id, row.turn_count);
  return result;
}

/**
 * Batch-fetch one message-content search snippet per session (issue #67),
 * given an FTS5 MATCH expression (see buildFtsMatch). Returns a map
 * sessionId → { snippet, role }. The chosen hit follows the same priority as
 * listSessions' tier ranking: a main-conversation user message wins over a main
 * assistant message, which wins over a sub-agent's internal turn (agent_id NOT
 * NULL); within a group, the earliest match (lowest sequence_num) is used. So
 * the chip's role lines up with the row's rank. The snippet wraps matched
 * tokens in the SNIPPET_MARK_* control chars so the frontend can render
 * highlights without any HTML. Sessions with no message hit (e.g. a
 * metadata-only match) are simply absent from the map.
 *
 * SQL is built with positional placeholders that vary by id count, so this is
 * intentionally not statement-cached.
 */
export function getMessageMatchesForSessions(
  sessionIds: string[],
  ftsMatch: string,
): Map<string, MessageMatch> {
  const result = new Map<string, MessageMatch>();
  if (sessionIds.length === 0) return result;

  const db = getDb();
  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = db.prepare(`
    WITH matched AS (
      SELECT e.session_id, e.event_type, e.sequence_num, e.agent_id,
        CASE WHEN e.event_type = 'user_message'
          THEN snippet(events_fts, 0, ?, ?, '…', 10)
          ELSE snippet(events_fts, 1, ?, ?, '…', 10)
        END AS snip
      FROM events_fts f JOIN events e ON e.id = f.rowid
      WHERE events_fts MATCH ? AND e.session_id IN (${placeholders})
    ),
    ranked AS (
      -- Priority MUST stay aligned with listSessions' content_rank tiers
      -- (user > assistant > sub-agent, earliest sequence_num wins) so the
      -- chip's role matches the row's rank. Keep these two in sync.
      SELECT session_id, event_type, agent_id, snip,
        ROW_NUMBER() OVER (PARTITION BY session_id
          ORDER BY
            CASE WHEN agent_id IS NOT NULL THEN 2
                 WHEN event_type = 'user_message' THEN 0
                 ELSE 1 END,
            sequence_num) AS rn
      FROM matched
    )
    SELECT session_id,
      CASE WHEN agent_id IS NOT NULL THEN 'subagent'
           WHEN event_type = 'user_message' THEN 'user'
           ELSE 'assistant' END AS role,
      snip
    FROM ranked WHERE rn = 1
  `).all(
    SNIPPET_MARK_START, SNIPPET_MARK_END,
    SNIPPET_MARK_START, SNIPPET_MARK_END,
    ftsMatch,
    ...sessionIds,
  ) as { session_id: string; role: 'user' | 'assistant' | 'subagent'; snip: string | null }[];

  for (const r of rows) {
    // snippet() is NULL when the chosen column is NULL (e.g. a user_message row
    // whose match was actually in output_data) — skip those.
    if (r.snip == null) continue;
    result.set(r.session_id, { snippet: r.snip, role: r.role });
  }
  return result;
}

/**
 * Count events for a session. When `parentOnly` is true, sub-agent events
 * (non-NULL `agent_id`) are excluded — mirroring the parent-only filter the
 * Timeline list uses, so the tab badge matches the default landing view.
 */
export function getEventCountBySession(sessionId: string, parentOnly = false): number {
  const db = getDb();
  if (parentOnly) {
    _eventCountParentOnlyStmt ??= db.prepare(
      'SELECT COUNT(*) as count FROM events WHERE session_id = ? AND agent_id IS NULL',
    );
    return (_eventCountParentOnlyStmt.get(sessionId) as { count: number }).count;
  }
  _eventCountBySessionStmt ??= db.prepare('SELECT COUNT(*) as count FROM events WHERE session_id = ?');
  return (_eventCountBySessionStmt.get(sessionId) as { count: number }).count;
}

export interface EventTypeCounts {
  /** Total across every event type — what the unfiltered ("All") view shows. */
  all: number;
  user_message: number;
  assistant_message: number;
  tool_call_start: number;
}

/**
 * Per-event-type counts for a session, used by the Timeline filter pills.
 * Mirrors the WHERE clause of `listEventsBySession` (minus the event_type
 * condition) so each pill's count equals the `total` that filter would return.
 * When `parentOnly` is true, sub-agent events are excluded — matching the
 * Timeline's parent-only mode for sessions with sub-agents.
 */
export function getEventTypeCounts(sessionId: string, parentOnly = false): EventTypeCounts {
  const db = getDb();
  const stmt = parentOnly
    ? (_eventTypeCountsParentOnlyStmt ??= db.prepare(
        'SELECT event_type, COUNT(*) as count FROM events WHERE session_id = ? AND agent_id IS NULL GROUP BY event_type',
      ))
    : (_eventTypeCountsStmt ??= db.prepare(
        'SELECT event_type, COUNT(*) as count FROM events WHERE session_id = ? GROUP BY event_type',
      ));
  const rows = stmt.all(sessionId) as { event_type: string; count: number }[];
  const counts: EventTypeCounts = { all: 0, user_message: 0, assistant_message: 0, tool_call_start: 0 };
  for (const { event_type, count } of rows) {
    counts.all += count;
    if (event_type === 'user_message' || event_type === 'assistant_message' || event_type === 'tool_call_start') {
      counts[event_type] = count;
    }
  }
  return counts;
}

interface AnnotationEventRow {
  sequence_num: number;
  event_type: string;
  timestamp: string;
  tool_name: string | null;
  file_path: string | null;
  input_preview: string | null;
  output_chars: number | null;
}

function classifyTool(toolName: string): EventAnnotation['marker_type'] {
  switch (toolName) {
    case 'Read': case 'ReadFile': case 'Glob': case 'Grep':
      return 'file_read';
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return 'file_write';
    case 'Agent': case 'Task': case 'SendMessage':
      return 'agent';
    case 'Bash':
      return 'bash';
    default:
      return 'other_tool';
  }
}

function extractLabel(row: AnnotationEventRow): string {
  if (row.file_path) return row.file_path;
  if (row.input_preview) {
    // Try to extract a file path or meaningful snippet from the preview
    const pathMatch = row.input_preview.match(/(?:file_path|path)["']?\s*[:=]\s*["']?([^\s"',}]+)/);
    if (pathMatch) return pathMatch[1];
    // For bash commands, show a short preview
    if (row.tool_name === 'Bash') {
      const cmdMatch = row.input_preview.match(/(?:command)["']?\s*[:=]\s*["']?([^\n"']{1,60})/);
      if (cmdMatch) return cmdMatch[1];
    }
  }
  return row.tool_name ?? 'unknown';
}

export function getTokenTimelineAnnotations(sessionId: string): EventAnnotation[] {
  const db = getDb();
  _annotationEventsStmt ??= db.prepare(`
    SELECT
      sequence_num, event_type, timestamp, tool_name,
      json_extract(input_data, '$.file_path') as file_path,
      input_preview,
      length(output_data) as output_chars
    FROM events
    WHERE session_id = ? AND agent_id IS NULL
      AND event_type IN ('assistant_message', 'compaction', 'tool_call_start')
    ORDER BY sequence_num ASC, timestamp ASC
  `);

  const rows = _annotationEventsStmt.all(sessionId) as AnnotationEventRow[];

  const annotations: EventAnnotation[] = [];

  for (const row of rows) {
    if (row.event_type !== 'tool_call_start' || !row.tool_name) continue;
    annotations.push({
      timestamp: row.timestamp,
      marker_type: classifyTool(row.tool_name),
      tool_name: row.tool_name,
      label: extractLabel(row),
      token_delta: row.output_chars != null ? Math.round(row.output_chars / 4) : undefined,
    });
  }

  return annotations;
}
