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

  // Fetch all events with tokens in one query, ordered by sequence
  _compactionEventsStmt ??= db.prepare(`
    SELECT id, event_type, timestamp, input_tokens, metadata
    FROM events
    WHERE session_id = ? AND (event_type = 'compaction' OR input_tokens IS NOT NULL)
    ORDER BY sequence_num ASC, timestamp ASC
  `);
  const allEvents = _compactionEventsStmt.all(sessionId) as { id: number; event_type: string; timestamp: string; input_tokens: number | null; metadata: string | null }[];

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

    // Find next event with tokens
    let tokensAfter = 0;
    for (let j = i + 1; j < allEvents.length; j++) {
      if (allEvents[j].input_tokens != null) {
        tokensAfter = allEvents[j].input_tokens!;
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
      tokens_before: evt.input_tokens ?? 0,
      tokens_after: tokensAfter,
      trigger,
      likely_dropped: likelyDropped,
    });
  }

  return details;
}
