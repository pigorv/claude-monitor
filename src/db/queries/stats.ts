import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getDb, getDbPath, onDbClose } from '../connection.js';
import type { FileActivityData, FileActivityEntry } from '../../shared/types.js';

// ── Cached prepared statements ──────────────────────────────────────
let _dbStatsStmt: Database.Statement | null = null;
let _eventCountStmt: Database.Statement | null = null;
let _toolFreqStmt: Database.Statement | null = null;
let _sessionStatsToolsStmt: Database.Statement | null = null;
let _sessionStatsFilesStmt: Database.Statement | null = null;
let _fileActivityGroupedStmt: Database.Statement | null = null;
let _fileActivityTimestampsStmt: Database.Statement | null = null;
let _fileActivityGroupedMainStmt: Database.Statement | null = null;
let _fileActivityTimestampsMainStmt: Database.Statement | null = null;
let _peakParentTokensStmt: Database.Statement | null = null;

onDbClose(() => {
  _dbStatsStmt = _eventCountStmt = _toolFreqStmt =
    _sessionStatsToolsStmt = _sessionStatsFilesStmt =
    _fileActivityGroupedStmt = _fileActivityTimestampsStmt =
    _fileActivityGroupedMainStmt = _fileActivityTimestampsMainStmt =
    _peakParentTokensStmt = null;
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

// ── File activity for Context tab ───────────────────────────────────

interface FileActivityRow {
  file_path: string;
  read_count: number;
  total_tokens: number;
  first_read: string;
  has_partial: number;
}

interface FileTimestampRow {
  file_path: string;
  timestamp: string;
}

const FILE_ACTIVITY_GROUPED_SQL = `
    SELECT
      json_extract(input_data, '$.file_path') as file_path,
      COUNT(*) as read_count,
      SUM(COALESCE(output_tokens, 0)) as total_tokens,
      MIN(timestamp) as first_read,
      MAX(CASE WHEN json_extract(input_data, '$.offset') IS NOT NULL
           OR json_extract(input_data, '$.limit') IS NOT NULL THEN 1 ELSE 0 END) as has_partial
    FROM events
    WHERE session_id = ? AND tool_name = 'Read'
      AND input_data IS NOT NULL
      AND json_extract(input_data, '$.file_path') IS NOT NULL`;

const FILE_ACTIVITY_TIMESTAMPS_SQL = `
      SELECT
        json_extract(input_data, '$.file_path') as file_path,
        timestamp
      FROM events
      WHERE session_id = ? AND tool_name = 'Read'
        AND input_data IS NOT NULL
        AND json_extract(input_data, '$.file_path') IS NOT NULL`;

const MAIN_ONLY_FILTER = `AND (agent_id IS NULL OR agent_id = '')`;

function buildFileEntries(
  groupedRows: FileActivityRow[],
  timestampMap: Map<string, string[]> | null,
  compactionTimestamps: string[],
): { files: FileActivityEntry[]; totalRereadTokens: number; rereadAfterCompactionCount: number } {
  let totalRereadTokens = 0;
  let rereadAfterCompactionCount = 0;

  const files: FileActivityEntry[] = groupedRows.map(row => {
    const isSkillFile = row.file_path.includes('.claude/skills/') || row.file_path.includes('/.skills/');

    let isRereadAfterCompaction = false;
    if (row.read_count >= 2 && timestampMap) {
      const readTimes = timestampMap.get(row.file_path) ?? [];
      for (const compTs of compactionTimestamps) {
        const hasBefore = readTimes.some(rt => rt < compTs);
        const hasAfter = readTimes.some(rt => rt > compTs);
        if (hasBefore && hasAfter) {
          isRereadAfterCompaction = true;
          break;
        }
      }
    }

    if (row.read_count >= 2) {
      totalRereadTokens += row.total_tokens;
    }
    if (isRereadAfterCompaction) {
      rereadAfterCompactionCount++;
    }

    return {
      file_path: row.file_path,
      read_count: row.read_count,
      total_tokens: row.total_tokens,
      first_read: row.first_read,
      has_partial: row.has_partial === 1,
      is_reread_after_compaction: isRereadAfterCompaction,
      is_skill_file: isSkillFile,
    };
  });

  return { files, totalRereadTokens, rereadAfterCompactionCount };
}

function buildTimestampMap(rows: FileTimestampRow[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.file_path);
    if (list) list.push(row.timestamp);
    else map.set(row.file_path, [row.timestamp]);
  }
  return map;
}

export function getFileActivity(sessionId: string, compactionTimestamps: string[]): FileActivityData {
  const db = getDb();

  // All reads (including subagents)
  _fileActivityGroupedStmt ??= db.prepare(
    `${FILE_ACTIVITY_GROUPED_SQL} GROUP BY file_path ORDER BY total_tokens DESC`
  );
  const allRows = _fileActivityGroupedStmt.all(sessionId) as FileActivityRow[];

  // Main-context-only reads
  _fileActivityGroupedMainStmt ??= db.prepare(
    `${FILE_ACTIVITY_GROUPED_SQL} ${MAIN_ONLY_FILTER} GROUP BY file_path ORDER BY total_tokens DESC`
  );
  const mainRows = _fileActivityGroupedMainStmt.all(sessionId) as FileActivityRow[];

  // Timestamp maps for re-read-after-compaction detection
  let allTimestampMap: Map<string, string[]> | null = null;
  let mainTimestampMap: Map<string, string[]> | null = null;
  if (compactionTimestamps.length > 0) {
    _fileActivityTimestampsStmt ??= db.prepare(
      `${FILE_ACTIVITY_TIMESTAMPS_SQL} ORDER BY timestamp ASC`
    );
    allTimestampMap = buildTimestampMap(
      _fileActivityTimestampsStmt.all(sessionId) as FileTimestampRow[]
    );

    _fileActivityTimestampsMainStmt ??= db.prepare(
      `${FILE_ACTIVITY_TIMESTAMPS_SQL} ${MAIN_ONLY_FILTER} ORDER BY timestamp ASC`
    );
    mainTimestampMap = buildTimestampMap(
      _fileActivityTimestampsMainStmt.all(sessionId) as FileTimestampRow[]
    );
  }

  const main = buildFileEntries(mainRows, mainTimestampMap, compactionTimestamps);
  const all = buildFileEntries(allRows, allTimestampMap, compactionTimestamps);

  return {
    files: main.files,
    total_reread_tokens: main.totalRereadTokens,
    reread_after_compaction_count: main.rereadAfterCompactionCount,
    files_with_subagents: all.files,
    total_reread_tokens_with_subagents: all.totalRereadTokens,
    reread_after_compaction_count_with_subagents: all.rereadAfterCompactionCount,
  };
}

// ── Peak parent tokens ──────────────────────────────────────────────

export function getPeakParentTokens(sessionId: string): number | null {
  const db = getDb();
  _peakParentTokensStmt ??= db.prepare(`
    SELECT MAX(input_tokens) as peak_tokens
    FROM events
    WHERE session_id = ? AND agent_id IS NULL AND input_tokens IS NOT NULL
  `);
  const row = _peakParentTokensStmt.get(sessionId) as { peak_tokens: number | null } | undefined;
  return row?.peak_tokens ?? null;
}
