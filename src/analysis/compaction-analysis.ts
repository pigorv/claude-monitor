import { getDb } from '../db/connection.js';
import type { CompactionDetail } from '../shared/types.js';

export function analyzeCompactions(sessionId: string): CompactionDetail[] {
  const db = getDb();

  // Get compaction events
  const compactions = db.prepare(`
    SELECT id, timestamp, input_tokens, metadata
    FROM events
    WHERE session_id = ? AND event_type = 'compaction'
    ORDER BY sequence_num ASC, timestamp ASC
  `).all(sessionId) as { id: number; timestamp: string; input_tokens: number | null; metadata: string | null }[];

  const details: CompactionDetail[] = [];

  for (const comp of compactions) {
    // Find the event right after compaction to get tokens_after
    const nextEvent = db.prepare(`
      SELECT input_tokens FROM events
      WHERE session_id = ? AND timestamp > ? AND input_tokens IS NOT NULL
      ORDER BY timestamp ASC LIMIT 1
    `).get(sessionId, comp.timestamp) as { input_tokens: number } | undefined;

    // Find events before compaction to categorize what was likely dropped
    const beforeEvents = db.prepare(`
      SELECT event_type, tool_name, COUNT(*) as count
      FROM events
      WHERE session_id = ? AND timestamp < ?
      GROUP BY event_type, tool_name
      ORDER BY count DESC
      LIMIT 10
    `).all(sessionId, comp.timestamp) as { event_type: string; tool_name: string | null; count: number }[];

    let trigger: 'auto' | 'manual' = 'auto';
    if (comp.metadata) {
      try {
        const meta = JSON.parse(comp.metadata);
        if (meta.trigger === 'manual') trigger = 'manual';
      } catch {
        // ignore corrupt metadata
      }
    }

    const likelyDropped: string[] = [];
    for (const evt of beforeEvents) {
      if (evt.tool_name) {
        likelyDropped.push(`${evt.count}x ${evt.tool_name} outputs`);
      } else if (evt.event_type === 'thinking') {
        likelyDropped.push(`${evt.count}x thinking blocks`);
      } else if (evt.event_type === 'assistant_message') {
        likelyDropped.push(`${evt.count}x assistant messages`);
      }
    }

    details.push({
      event_id: comp.id,
      timestamp: comp.timestamp,
      tokens_before: comp.input_tokens ?? 0,
      tokens_after: nextEvent?.input_tokens ?? 0,
      trigger,
      likely_dropped: likelyDropped.slice(0, 5),
    });
  }

  return details;
}
