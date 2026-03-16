import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getDb, getDbPath, onDbClose } from '../connection.js';

// ── Cached prepared statements ──────────────────────────────────────
let _dbStatsStmt: Database.Statement | null = null;
let _eventCountStmt: Database.Statement | null = null;
let _toolFreqStmt: Database.Statement | null = null;
let _sessionStatsToolsStmt: Database.Statement | null = null;
let _sessionStatsFilesStmt: Database.Statement | null = null;

onDbClose(() => {
  _dbStatsStmt = _eventCountStmt = _toolFreqStmt =
    _sessionStatsToolsStmt = _sessionStatsFilesStmt = null;
});

export interface DbStats {
  sessionCount: number;
  eventCount: number;
  dbSizeBytes: number;
  oldestSession: string | null;
  newestSession: string | null;
}

export function getDbStats(): DbStats {
  const db = getDb();

  _dbStatsStmt ??= db.prepare(`
    SELECT
      COUNT(*) as count,
      MIN(started_at) as oldest,
      MAX(started_at) as newest
    FROM sessions
  `);
  const sessionRow = _dbStatsStmt.get() as { count: number; oldest: string | null; newest: string | null };

  _eventCountStmt ??= db.prepare('SELECT COUNT(*) as count FROM events');
  const eventRow = _eventCountStmt.get() as { count: number };

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
  _toolFreqStmt ??= db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM events
    WHERE session_id = ? AND tool_name IS NOT NULL
    GROUP BY tool_name
    ORDER BY count DESC
  `);
  return _toolFreqStmt.all(sessionId) as ToolFrequencyEntry[];
}

export interface SessionStatsResult {
  uniqueTools: string[];
  avgDurationMs: number;
  filesRead: string[];
  filesWritten: string[];
}

export function getSessionStats(sessionId: string): SessionStatsResult {
  const db = getDb();

  // Consolidated query: unique tools + avg duration in one pass
  _sessionStatsToolsStmt ??= db.prepare(`
    SELECT
      GROUP_CONCAT(DISTINCT tool_name) as unique_tools,
      AVG(duration_ms) as avg_duration
    FROM events
    WHERE session_id = ? AND tool_name IS NOT NULL
  `);
  const toolRow = _sessionStatsToolsStmt.get(sessionId) as { unique_tools: string | null; avg_duration: number | null };

  // Consolidated query: files read + written in one pass
  _sessionStatsFilesStmt ??= db.prepare(`
    SELECT DISTINCT
      tool_name,
      json_extract(input_data, '$.file_path') as file_path
    FROM events
    WHERE session_id = ? AND tool_name IN ('Read', 'Write', 'Edit')
      AND input_data IS NOT NULL
      AND json_extract(input_data, '$.file_path') IS NOT NULL
  `);
  const fileRows = _sessionStatsFilesStmt.all(sessionId) as { tool_name: string; file_path: string }[];

  const filesRead: string[] = [];
  const filesWritten: string[] = [];
  for (const row of fileRows) {
    if (row.tool_name === 'Read') {
      filesRead.push(row.file_path);
    } else {
      filesWritten.push(row.file_path);
    }
  }

  return {
    uniqueTools: toolRow.unique_tools ? toolRow.unique_tools.split(',') : [],
    avgDurationMs: toolRow.avg_duration ?? 0,
    filesRead,
    filesWritten,
  };
}
