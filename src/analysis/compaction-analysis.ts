import type Database from 'better-sqlite3';
import { getDb, onDbClose } from '../db/connection.js';
import type { CompactionDetail } from '../shared/types.js';

// ── Cached prepared statements ──────────────────────────────────────
let _compactionEventsStmt: Database.Statement | null = null;
let _eventSummaryStmt: Database.Statement | null = null;

onDbClose(() => {
  _compactionEventsStmt = _eventSummaryStmt = null;
});

export function analyzeCompactions(sessionId: string): CompactionDetail[] {
  const db = getDb();

  // Fetch all parent events with tokens in one query, ordered by sequence.
  // agent_id IS NULL restricts the scan to parent (non-subagent) rows so the
  // before/after lookup never reads a subagent row (issue #101). The agent_id
  // in ORDER BY is intentionally explicit for robustness even though the filter
  // makes it degenerate to (sequence_num, timestamp).
  _compactionEventsStmt ??= db.prepare(`
    SELECT id, event_type, timestamp, input_tokens, cache_read_tokens, cache_write_tokens, metadata
    FROM events
    WHERE session_id = ? AND agent_id IS NULL AND (event_type = 'compaction' OR input_tokens IS NOT NULL)
    ORDER BY agent_id ASC, sequence_num ASC, timestamp ASC
  `);
  const allEvents = _compactionEventsStmt.all(sessionId) as {
    id: number;
    event_type: string;
    timestamp: string;
    input_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    metadata: string | null;
  }[];

  // Effective context = fresh input + cached reads + cached writes. Raw
  // input_tokens alone is only the non-cached slice and understates context.
  const effectiveContext = (row: { input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null }): number =>
    (row.input_tokens ?? 0) + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0);

  // Fetch event type/tool summary for the session once (for likely_dropped)
  _eventSummaryStmt ??= db.prepare(`
    SELECT event_type, tool_name, COUNT(*) as count
    FROM events
    WHERE session_id = ?
    GROUP BY event_type, tool_name
    ORDER BY count DESC
  `);
  const eventSummary = _eventSummaryStmt.all(sessionId) as { event_type: string; tool_name: string | null; count: number }[];

  const details: CompactionDetail[] = [];

  for (let i = 0; i < allEvents.length; i++) {
    const evt = allEvents[i];
    if (evt.event_type !== 'compaction') continue;

    // The compaction event is the post-drop (low-context) message.
    const tokensAfter = effectiveContext(evt);

    // tokens_before = effective context of the nearest preceding event that
    // has tokens (the pre-drop peak). Fall back to tokensAfter if none precedes
    // so "Tokens Lost" is never negative.
    let tokensBefore = tokensAfter;
    for (let j = i - 1; j >= 0; j--) {
      if (allEvents[j].input_tokens != null) {
        tokensBefore = effectiveContext(allEvents[j]);
        break;
      }
    }

    let trigger: 'auto' | 'manual' = 'auto';
    if (evt.metadata) {
      try {
        const meta = JSON.parse(evt.metadata);
        if (meta.trigger === 'manual') trigger = 'manual';
      } catch {
        // ignore corrupt metadata
      }
    }

    const likelyDropped: string[] = [];
    for (const entry of eventSummary) {
      if (entry.tool_name) {
        likelyDropped.push(`${entry.count}x ${entry.tool_name} outputs`);
      } else if (entry.event_type === 'thinking') {
        likelyDropped.push(`${entry.count}x thinking blocks`);
      } else if (entry.event_type === 'assistant_message') {
        likelyDropped.push(`${entry.count}x assistant messages`);
      }
      if (likelyDropped.length >= 5) break;
    }

    details.push({
      event_id: evt.id,
      timestamp: evt.timestamp,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      trigger,
      likely_dropped: likelyDropped,
    });
  }

  return details;
}
