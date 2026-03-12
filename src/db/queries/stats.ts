import { statSync } from 'node:fs';
import { getDb, getDbPath } from '../connection.js';

export interface DbStats {
  sessionCount: number;
  eventCount: number;
  dbSizeBytes: number;
  oldestSession: string | null;
  newestSession: string | null;
}

export function getDbStats(): DbStats {
  const db = getDb();

  const sessionRow = db.prepare(`
    SELECT
      COUNT(*) as count,
      MIN(started_at) as oldest,
      MAX(started_at) as newest
    FROM sessions
  `).get() as { count: number; oldest: string | null; newest: string | null };

  const eventRow = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };

  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(getDbPath()).size;
  } catch {
    // DB file may not exist yet
  }

  return {
    sessionCount: sessionRow.count,
    eventCount: eventRow.count,
    dbSizeBytes,
    oldestSession: sessionRow.oldest,
    newestSession: sessionRow.newest,
  };
}

export interface ToolFrequencyEntry {
  tool_name: string;
  count: number;
}

export function getToolFrequency(sessionId: string): ToolFrequencyEntry[] {
  const db = getDb();
  return db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM events
    WHERE session_id = ? AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
  `).all(sessionId) as ToolFrequencyEntry[];
}

export interface SessionStatsResult {
  uniqueTools: string[];
  avgDurationMs: number;
  filesRead: string[];
  filesWritten: string[];
}

export function getSessionStats(sessionId: string): SessionStatsResult {
  const db = getDb();

  const tools = db.prepare(`
    SELECT DISTINCT tool_name FROM events
    WHERE session_id = ? AND tool_name IS NOT NULL
  `).all(sessionId) as { tool_name: string }[];

  const durationRow = db.prepare(`
    SELECT AVG(duration_ms) as avg_duration
    FROM events
    WHERE session_id = ? AND duration_ms IS NOT NULL
  `).get(sessionId) as { avg_duration: number | null };

  const filesRead = db.prepare(`
    SELECT DISTINCT json_extract(input_data, '$.file_path') as file_path
    FROM events
    WHERE session_id = ? AND tool_name = 'Read' AND input_data IS NOT NULL
      AND json_extract(input_data, '$.file_path') IS NOT NULL
  `).all(sessionId) as { file_path: string }[];

  const filesWritten = db.prepare(`
    SELECT DISTINCT json_extract(input_data, '$.file_path') as file_path
    FROM events
    WHERE session_id = ? AND tool_name IN ('Write', 'Edit') AND input_data IS NOT NULL
      AND json_extract(input_data, '$.file_path') IS NOT NULL
  `).all(sessionId) as { file_path: string }[];

  return {
    uniqueTools: tools.map((t) => t.tool_name),
    avgDurationMs: durationRow.avg_duration ?? 0,
    filesRead: filesRead.map((f) => f.file_path),
    filesWritten: filesWritten.map((f) => f.file_path),
  };
}
