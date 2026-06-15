import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { getDb } from '../db/connection.js';
import { deleteEventsBySession, insertEvents } from '../db/queries/events.js';
import { sessionExists, upsertSession, setSessionImportedMtime } from '../db/queries/sessions.js';
import * as logger from '../shared/logger.js';
import type { Event, Invocation, Session, TranscriptMessage } from '../shared/types.js';
import { parseTranscript, parseTranscriptWithTitle } from './jsonl-parser.js';
import { extractAllEvents, mergeToolCallEvents, assignAgentIds, type ParsedEvent } from './thinking-extractor.js';
import { buildTokenSnapshots, computeAggregates, estimateContextPct, dedupeByMessageId } from './token-tracker.js';
import { generateSessionSummary } from '../analysis/session-summary.js';
import { computeAgentEfficiency, inferExecutionModes, analyzeAgentFileReads } from '../analysis/agent-efficiency.js';
import { getAllAgentTokenTimelines, updateAgentRelationship } from '../db/queries/sessions.js';
import { detectAndLinkSessions } from './session-linker.js';

// Reset commands that wipe or compact context. They start a session mechanically
// but never describe it, so they're excluded from the fallback title, the
// "started with" pill, and the invocation list.
const RESET_COMMANDS = new Set(['clear', 'compact']);

/** True when a slash-command name (with or without a leading "/") is a reset command. */
function isResetCommandName(name: string): boolean {
  return RESET_COMMANDS.has(name.trim().replace(/^\//, '').toLowerCase());
}

// ── Import result ──────────────────────────────────────────────────

export interface ImportResult {
  sessionId: string;
  eventCount: number;
  skipped: boolean;
  error?: string;
}

// ── Single file import ─────────────────────────────────────────────

/**
 * Import a single JSONL transcript file into the database.
 * Returns the import result. Skips if the session already exists (idempotent).
 */
export async function importTranscript(
  filePath: string,
  options: { force?: boolean } = {},
): Promise<ImportResult> {
  // Detect subagent transcripts — these should not be imported as standalone sessions.
  // They are imported as child events when their parent session is processed.
  if (isSubagentFile(filePath)) {
    const parentSessionId = await deriveSessionIdFromFile(filePath);
    if (parentSessionId && sessionExists(parentSessionId)) {
      // Parent already imported — import this subagent's events as children
      const agentId = basename(filePath, '.jsonl');
      const result = await importSubagentFile(parentSessionId, agentId, filePath, { force: options.force });
      if (!result.skipped) {
        logger.info('Imported subagent transcript', { parentSessionId, agentId, events: result.events });
      }
      return { sessionId: parentSessionId, eventCount: result.events, skipped: result.skipped };
    }
    // Parent not imported yet — skip. It will be picked up when the parent is imported.
    logger.debug('Subagent file skipped (parent not imported yet)', { filePath });
    return { sessionId: '', eventCount: 0, skipped: true };
  }

  // Capture the file's mtime BEFORE parsing. If the file is appended to between
  // here and the read below, this stored value stays conservatively older, so the
  // next scan re-imports (idempotent) rather than skipping the new tail. The watcher
  // seeds knownMtimes from this on startup to avoid re-parsing unchanged sessions.
  let fileMtimeMs: number | null = null;
  try {
    fileMtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // ignore — file may have vanished; we simply won't persist an mtime
  }

  // Fast path: skip an already-imported parent without reading the file body.
  // deriveSessionId already falls back to basename(filePath) when no message
  // carries a sessionId, so for the common case (filename === sessionId) we can
  // decide here. The post-parse sessionExists guard below remains the fallback
  // for files whose embedded sessionId differs from the filename.
  if (!options.force) {
    const candidateId = basename(filePath, '.jsonl');
    if (candidateId && sessionExists(candidateId)) {
      if (fileMtimeMs !== null) setSessionImportedMtime(candidateId, fileMtimeMs);
      logger.debug('Session already imported, skipping (pre-parse)', { sessionId: candidateId, filePath });
      return { sessionId: candidateId, eventCount: 0, skipped: true };
    }
  }

  // Collect all messages and the session title from the file in a single pass.
  // Use the transcript-recorded title (user rename or AI title) if available;
  // fall back to first user message below.
  const { messages, title: sessionTitle } = await parseTranscriptWithTitle(filePath);

  if (messages.length === 0) {
    return { sessionId: '', eventCount: 0, skipped: true, error: 'No messages found in file' };
  }

  // Derive session ID from the first message that has one
  const sessionId = deriveSessionId(messages, filePath);
  if (!sessionId) {
    return { sessionId: '', eventCount: 0, skipped: true, error: 'Could not determine session ID' };
  }

  // Check idempotency
  if (!options.force && sessionExists(sessionId)) {
    // Record the mtime even when skipping so the watcher can seed from it on the
    // next startup and avoid re-parsing this already-imported session (lazy
    // backfill for sessions imported before last_imported_mtime existed).
    if (fileMtimeMs !== null) setSessionImportedMtime(sessionId, fileMtimeMs);
    logger.debug('Session already imported, skipping', { sessionId, filePath });
    return { sessionId, eventCount: 0, skipped: true };
  }

  // Extract events from messages, merge tool start/end, and assign agent IDs
  const rawEvents = extractAllEvents(messages);
  const parsedEvents = mergeToolCallEvents(rawEvents);
  const agentInfos = assignAgentIds(parsedEvents);

  // Compute tool call and subagent counts once (used by summary and session record)
  const toolCounts = new Map<string, number>();
  let toolCallCount = 0;
  let subagentCount = 0;
  for (const e of parsedEvents) {
    if (e.event_type === 'tool_call_start') {
      toolCallCount++;
      if (e.tool_name) {
        toolCounts.set(e.tool_name, (toolCounts.get(e.tool_name) ?? 0) + 1);
      }
      if (e.tool_name === 'Task' || e.tool_name === 'Agent') {
        subagentCount++;
      }
    }
  }
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  // Build token snapshots
  const model = deriveModel(messages);
  const aggregates = computeAggregates(buildTokenSnapshots(messages, model));

  const durationMs = new Date(messages[messages.length - 1].timestamp).getTime() - new Date(messages[0].timestamp).getTime();

  let firstUserMessage: string | undefined;
  if (!sessionTitle) {
    // Fall back to the first meaningful user event in transcript order: either a
    // non-reset slash command or a plain-text prompt, whichever the user did first.
    // Synthetic events never qualify — system_generated/skill_expansion subtypes
    // come from the extractor; <system-reminder>-only messages and user-side
    // interrupt markers carry no subtype (the extractor only tags interrupts on
    // assistant events), so those are excluded by prefix.
    const syntheticPrefix = /^(?:<(?:local-command-(?:caveat|stdout|stderr)|task-notification|system-reminder)>|\[request interrupted)/i;
    for (const evt of parsedEvents) {
      if (evt.event_type !== 'user_message') continue;
      const meta = evt.metadata;
      if (meta?.subtype === 'system_generated' || meta?.subtype === 'skill_expansion') continue;
      const command = typeof meta?.command === 'string' ? meta.command : null;
      if (command) {
        if (isResetCommandName(command)) continue;
      } else {
        const trimmed = (evt.input_data ?? '').trim();
        if (!trimmed || syntheticPrefix.test(trimmed)) continue;
      }
      firstUserMessage = evt.input_data || undefined;
      break;
    }
  }

  const summary = sessionTitle || generateSessionSummary({
    model,
    durationMs: durationMs > 0 ? durationMs : null,
    toolCallCount,
    topTools,
    compactionCount: aggregates.compaction_count,
    subagentCount,
    peakContextPct: aggregates.peak_context_pct > 0 ? aggregates.peak_context_pct : null,
    firstUserMessage,
  });

  // Build session record
  const modelsUsed = deriveModelsUsed(messages);
  const invocations = deriveInvocations(parsedEvents);
  const startedWith = deriveStartedWith(parsedEvents);
  const session = buildSessionRecord(sessionId, filePath, messages, model, modelsUsed, invocations, startedWith, aggregates, toolCallCount, subagentCount, summary);

  // Build event records with token info from snapshots
  const eventRecords = buildEventRecords(sessionId, parsedEvents, messages, model);

  // Write to DB in a single transaction
  const db = getDb();
  db.transaction(() => {
    if (options.force) {
      db.prepare('DELETE FROM agent_relationships WHERE parent_session_id = ?').run(sessionId);
      db.prepare('DELETE FROM session_links WHERE source_session_id = ? OR target_session_id = ?').run(sessionId, sessionId);
    }
    // Delete ALL prior events for this session before re-inserting.
    // The full transcript parse is authoritative and regenerates everything.
    // Previously this only deleted hook events, causing transcript_import
    // events to accumulate on re-import.
    deleteEventsBySession(sessionId);
    upsertSession(session);
    if (eventRecords.length > 0) {
      insertEvents(eventRecords);
    }
    // Upsert agent relationships from transcript (handles resumed agents with same ID)
    const upsertAgentRel = db.prepare(`INSERT INTO agent_relationships (
      parent_session_id, child_agent_id, prompt_preview, result_preview,
      prompt_data, result_data, started_at, ended_at, duration_ms, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(parent_session_id, child_agent_id) DO UPDATE SET
      ended_at = MAX(agent_relationships.ended_at, excluded.ended_at),
      duration_ms = excluded.duration_ms,
      result_preview = COALESCE(excluded.result_preview, agent_relationships.result_preview),
      result_data = COALESCE(excluded.result_data, agent_relationships.result_data),
      status = excluded.status`);
    for (const agent of agentInfos) {
      const startMs = new Date(agent.startTimestamp).getTime();
      const endMs = new Date(agent.endTimestamp).getTime();
      upsertAgentRel.run(
        sessionId,
        agent.agentId,
        agent.description ? agent.description.slice(0, 200) : null,
        agent.result ? agent.result.slice(0, 200) : null,
        agent.prompt || null,
        agent.result || null,
        agent.startTimestamp,
        agent.endTimestamp,
        endMs > startMs ? endMs - startMs : null,
        'completed',
      );
    }
  })();

    // Compute agent efficiency metrics (second pass, after all data is inserted)
    if (agentInfos.length > 0) {
      const agents = agentInfos.map((a) => ({
        started_at: a.startTimestamp,
        ended_at: a.endTimestamp,
      }));
      const executionModes = inferExecutionModes(agents);

      // Batch-fetch all agent token timelines in one query
      const allTimelines = getAllAgentTokenTimelines(sessionId);

      // Prepare the update statement once — all iterations use the same columns
      const updateAgentRelStmt = db.prepare(`UPDATE agent_relationships SET
        prompt_tokens = @prompt_tokens,
        result_tokens = @result_tokens,
        peak_context_tokens = @peak_context_tokens,
        compression_ratio = @compression_ratio,
        agent_compaction_count = @agent_compaction_count,
        parent_headroom_at_return = @parent_headroom_at_return,
        parent_impact_pct = @parent_impact_pct,
        result_classification = @result_classification,
        execution_mode = @execution_mode,
        files_read_count = @files_read_count,
        files_total_tokens = @files_total_tokens,
        spawn_timestamp = @spawn_timestamp,
        complete_timestamp = @complete_timestamp
      WHERE parent_session_id = @parentSessionId AND child_agent_id = @childAgentId`);

      for (let idx = 0; idx < agentInfos.length; idx++) {
        const agent = agentInfos[idx];
        const agentTimeline = allTimelines.get(agent.agentId) ?? [];

        // Find parent's input_tokens at the time the agent result entered context
        const parentTokensAtReturn = findParentTokensAtReturn(eventRecords, agent.endTimestamp);

        const efficiency = computeAgentEfficiency(
          agent.prompt || null,
          agent.result || null,
          agentTimeline,
          parentTokensAtReturn,
          model,
        );

        // Analyze file reads from agent events
        const agentEvents = eventRecords.filter((e) => e.agent_id === agent.agentId);
        const fileReads = analyzeAgentFileReads(agentEvents);

        updateAgentRelStmt.run({
          prompt_tokens: efficiency.prompt_tokens,
          result_tokens: efficiency.result_tokens,
          peak_context_tokens: efficiency.peak_context_tokens,
          compression_ratio: efficiency.compression_ratio,
          agent_compaction_count: efficiency.agent_compaction_count,
          parent_headroom_at_return: efficiency.parent_headroom_at_return,
          parent_impact_pct: efficiency.parent_impact_pct,
          result_classification: efficiency.result_classification,
          execution_mode: executionModes[idx],
          files_read_count: fileReads.filesReadCount,
          files_total_tokens: fileReads.filesTotalTokens,
          spawn_timestamp: agent.startTimestamp,
          complete_timestamp: agent.endTimestamp,
          parentSessionId: sessionId,
          childAgentId: agent.agentId,
        });
      }
    }

  // After importing the parent, discover and import subagent transcripts
  const subagentEventCount = await importSubagentTranscripts(sessionId, filePath, { force: options.force });

  // Update session totals to include agent tokens so that
  // parentTokens = sessionTotal - agentTotal yields a correct positive value
  if (subagentEventCount > 0) {
    const agentTotals = db.prepare(`
      SELECT COALESCE(SUM(input_tokens_total), 0) as agent_input,
             COALESCE(SUM(output_tokens_total), 0) as agent_output
      FROM agent_relationships
      WHERE parent_session_id = ? AND input_tokens_total IS NOT NULL
    `).get(sessionId) as { agent_input: number; agent_output: number };

    db.prepare(`
      UPDATE sessions SET
        total_input_tokens = total_input_tokens + ?,
        total_output_tokens = total_output_tokens + ?
      WHERE id = ?
    `).run(agentTotals.agent_input, agentTotals.agent_output, sessionId);
  }

  // Detect and link plan↔implementation session pairs
  const firstUserMsg = messages.find((m) => m.type === 'user');
  const firstUserText = firstUserMsg
    ? firstUserMsg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n')
    : null;
  detectAndLinkSessions(
    sessionId,
    firstUserText,
    session.project_path,
    session.started_at,
    session.ended_at,
  );

  // Persist the transcript mtime so the watcher skips this session on the next
  // startup unless the file changes again.
  if (fileMtimeMs !== null) setSessionImportedMtime(sessionId, fileMtimeMs);

  const totalEvents = eventRecords.length + subagentEventCount;
  logger.info('Imported transcript', {
    sessionId,
    events: totalEvents,
    subagentEvents: subagentEventCount,
    filePath,
  });

  return { sessionId, eventCount: totalEvents, skipped: false };
}

// ── Batch import ───────────────────────────────────────────────────

/**
 * Import multiple transcript files. Returns results for each file.
 */
export async function importTranscripts(
  filePaths: string[],
  options: { force?: boolean } = {},
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];

  // Drop subagent files whose parent is in the batch only under force, where the
  // parent is guaranteed to re-import (and so cover) its subagents. Under a
  // non-force batch an already-imported parent is skipped at the pre-parse fast
  // path and never reaches its subagents, so dropping a covered subagent would
  // silently strand a changed one. Keeping it is cheap: the unchanged-subagent
  // mtime guard skips it without re-parsing, and a fresh parent (processed first
  // in sorted order) already imported it, so the standalone re-pass mtime-skips.
  const filtered = options.force ? filterCoveredSubagents(filePaths) : filePaths;

  for (const filePath of filtered) {
    try {
      const result = await importTranscript(filePath, options);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to import transcript', { filePath, error: message });
      results.push({ sessionId: '', eventCount: 0, skipped: true, error: message });
    }
  }

  return results;
}

// ── Subagent transcript import ─────────────────────────────────────

/**
 * Check whether a file path is a subagent transcript (lives under a subagents/ directory).
 */
function isSubagentFile(filePath: string): boolean {
  return filePath.includes('/subagents/') || filePath.includes('\\subagents\\');
}

/**
 * Compute the parent transcript path for a subagent file — the inverse of
 * discoverSubagentFiles. Subagent: {projectDir}/{sessionId}/subagents/agent-*.jsonl
 * Parent:   {projectDir}/{sessionId}.jsonl
 */
function parentTranscriptPathForSubagent(subFile: string): string {
  const subagentsDir = dirname(subFile); // .../{sessionId}/subagents
  const sessionDir = dirname(subagentsDir); // .../{sessionId}
  return sessionDir + '.jsonl'; // .../{sessionId}.jsonl
}

/**
 * Drop subagent files whose parent transcript is also in the batch. Only sound
 * for force batches, where the parent is guaranteed to re-import (and so cover)
 * its subagents; importTranscripts gates the call on force for that reason.
 * Non-subagent files are always kept, and so are subagents whose parent is NOT
 * in the batch (e.g. the watcher's incremental single-file case, which goes
 * through importTranscript directly).
 */
export function filterCoveredSubagents(filePaths: string[]): string[] {
  const present = new Set(filePaths.map((p) => resolve(p)));
  return filePaths.filter((p) => {
    if (!isSubagentFile(p)) return true;
    const parent = resolve(parentTranscriptPathForSubagent(p));
    return !present.has(parent);
  });
}

/**
 * Read the sessionId from a transcript file without fully parsing it.
 */
async function deriveSessionIdFromFile(filePath: string): Promise<string | null> {
  for await (const msg of parseTranscript(filePath)) {
    if (msg.sessionId) return msg.sessionId;
  }
  return null;
}

/**
 * Discover subagent transcript files relative to a parent transcript path.
 * Claude Code stores them at: {sessionDir}/subagents/agent-*.jsonl
 * The parent transcript is at: {projectDir}/{sessionId}.jsonl
 * The subagent dir is at: {projectDir}/{sessionId}/subagents/
 */
function discoverSubagentFiles(parentTranscriptPath: string): string[] {
  const parentDir = dirname(parentTranscriptPath);
  const parentBasename = basename(parentTranscriptPath, '.jsonl');
  const subagentsDir = join(parentDir, parentBasename, 'subagents');

  if (!existsSync(subagentsDir)) return [];

  try {
    return readdirSync(subagentsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => resolve(subagentsDir, f))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Import all subagent transcripts for a parent session.
 * Returns the total number of subagent events inserted.
 */
async function importSubagentTranscripts(
  parentSessionId: string,
  parentTranscriptPath: string,
  options: { force?: boolean } = {},
): Promise<number> {
  const subagentFiles = discoverSubagentFiles(parentTranscriptPath);
  if (subagentFiles.length === 0) return 0;

  let totalEvents = 0;

  for (const subFile of subagentFiles) {
    const agentId = basename(subFile, '.jsonl');
    try {
      const result = await importSubagentFile(parentSessionId, agentId, subFile, options);
      totalEvents += result.events;
    } catch (err) {
      logger.error('Failed to import subagent transcript', {
        parentSessionId,
        agentId,
        file: subFile,
        error: String(err),
      });
    }
  }

  return totalEvents;
}

/**
 * Import a single subagent transcript file, inserting its events with the
 * given agent_id linked to the parent session.
 */
async function importSubagentFile(
  parentSessionId: string,
  agentId: string,
  filePath: string,
  options: { force?: boolean } = {},
): Promise<{ events: number; skipped: boolean }> {
  // Capture the file's mtime before parsing so we can skip an unchanged
  // standalone re-import (no delete/reinsert, no FTS churn) below.
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // ignore — file may have vanished; we simply won't persist an mtime
  }

  const db = getDb();

  // Fast path: skip an already-imported, unchanged subagent without reading the
  // file body. The force branch clears agent_relationships for the parent, so
  // this skip never fires under force (and freshly-created relationships from
  // assignAgentIds have NULL child_imported_mtime, so they still import).
  if (!options.force) {
    const existing = db.prepare(
      'SELECT child_imported_mtime, child_transcript_path FROM agent_relationships WHERE parent_session_id = ? AND child_agent_id = ?',
    ).get(parentSessionId, agentId) as { child_imported_mtime: number | null; child_transcript_path: string | null } | undefined;
    if (existing && existing.child_transcript_path === filePath && mtimeMs !== null && existing.child_imported_mtime === mtimeMs) {
      return { events: 0, skipped: true };
    }
  }

  const messages: TranscriptMessage[] = [];
  for await (const msg of parseTranscript(filePath)) {
    messages.push(msg);
  }
  if (messages.length === 0) return { events: 0, skipped: false };

  // Extract events from the subagent transcript
  const rawEvents = extractAllEvents(messages);
  const parsedEvents = mergeToolCallEvents(rawEvents);

  // Tag all events with the subagent's agent_id
  for (const evt of parsedEvents) {
    evt.agent_id = agentId;
  }

  // Build token snapshots for this subagent
  const model = messages.find((m) => m.model)?.model ?? null;

  // Build event records
  const eventRecords = buildEventRecords(parentSessionId, parsedEvents, messages, model);

  // Count tool calls in the subagent
  const toolCallCount = parsedEvents.filter((e) => e.event_type === 'tool_call_start').length;

  // Compute token totals — dedup streamed duplicates (same messageId) first so
  // cumulative usage isn't counted multiple times (issue #98). Mirror
  // buildTokenSnapshots(): only assistant messages with usage contribute.
  let totalInput = 0;
  let totalOutput = 0;
  for (const msg of dedupeByMessageId(messages)) {
    if (msg.type === 'assistant' && msg.usage) {
      totalInput += msg.usage.input_tokens;
      totalOutput += msg.usage.output_tokens;
    }
  }

  // Timestamps
  const startedAt = messages[0]?.timestamp ?? null;
  const endedAt = messages[messages.length - 1]?.timestamp ?? null;
  const durationMs = startedAt && endedAt
    ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
    : null;

  // Wrap all DB writes in a single transaction
  db.transaction(() => {
    // Clear ALL events for this subagent before inserting transcript data.
    // Previously only deleted hook events, causing duplicates on re-import.
    db.prepare('DELETE FROM events WHERE session_id = ? AND agent_id = ?')
      .run(parentSessionId, agentId);
    if (eventRecords.length > 0) {
      insertEvents(eventRecords);
    }

    // Extract prompt from the first user message
    const firstUserMsg = messages.find((m) => m.type === 'user');
    const promptText = firstUserMsg
      ? firstUserMsg.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
      : null;
    // Extract result from the last assistant message
    const lastAssistantMsg = [...messages].reverse().find((m) => m.type === 'assistant');
    const resultText = lastAssistantMsg
      ? lastAssistantMsg.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('\n')
      : null;

    // Upsert agent_relationships — update if exists (from parent transcript's assignAgentIds),
    // or insert if this is a new agent not seen in the parent transcript
    const existingRel = db.prepare(
      'SELECT id FROM agent_relationships WHERE parent_session_id = ? AND child_agent_id = ?',
    ).get(parentSessionId, agentId) as { id: number } | undefined;

    if (existingRel) {
      db.prepare(`UPDATE agent_relationships SET
        child_transcript_path = ?,
        child_imported_mtime = ?,
        tool_call_count = ?,
        input_tokens_total = ?,
        output_tokens_total = ?,
        prompt_preview = COALESCE(?, prompt_preview),
        result_preview = COALESCE(?, result_preview),
        prompt_data = COALESCE(?, prompt_data),
        result_data = COALESCE(?, result_data),
        started_at = COALESCE(started_at, ?),
        ended_at = COALESCE(ended_at, ?),
        duration_ms = COALESCE(duration_ms, ?),
        status = 'completed'
      WHERE id = ?`).run(
        filePath,
        mtimeMs,
        toolCallCount,
        totalInput,
        totalOutput,
        promptText ? promptText.slice(0, 200) : null,
        resultText ? resultText.slice(0, 200) : null,
        promptText,
        resultText,
        startedAt,
        endedAt,
        durationMs && durationMs > 0 ? durationMs : null,
        existingRel.id,
      );
    } else {
      db.prepare(`INSERT INTO agent_relationships (
        parent_session_id, child_agent_id, child_transcript_path, child_imported_mtime,
        prompt_preview, result_preview, prompt_data, result_data,
        started_at, ended_at, duration_ms,
        input_tokens_total, output_tokens_total, tool_call_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parentSessionId,
        agentId,
        filePath,
        mtimeMs,
        promptText ? promptText.slice(0, 200) : null,
        resultText ? resultText.slice(0, 200) : null,
        promptText,
        resultText,
        startedAt,
        endedAt,
        durationMs && durationMs > 0 ? durationMs : null,
        totalInput,
        totalOutput,
        toolCallCount,
        'completed',
      );
    }
  })();

  logger.debug('Imported subagent transcript', {
    parentSessionId,
    agentId,
    events: eventRecords.length,
    toolCalls: toolCallCount,
  });

  return { events: eventRecords.length, skipped: false };
}

// ── Internal helpers ───────────────────────────────────────────────

function deriveSessionId(messages: TranscriptMessage[], filePath: string): string | null {
  // Try sessionId from messages first
  for (const msg of messages) {
    if (msg.sessionId) return msg.sessionId;
  }

  // Fall back to filename (e.g., "abc-123.jsonl" → "abc-123")
  const filename = basename(filePath, '.jsonl');
  if (filename && filename !== '') return filename;

  return null;
}

function deriveModel(messages: TranscriptMessage[]): string | null {
  for (const msg of messages) {
    if (msg.model) return msg.model;
  }
  return null;
}

function deriveModelsUsed(messages: TranscriptMessage[]): string[] {
  const seen = new Set<string>();
  const models: string[] = [];
  for (const msg of messages) {
    if (msg.model && !seen.has(msg.model)) {
      seen.add(msg.model);
      models.push(msg.model);
    }
  }
  return models;
}

// Captures whether the session was *started* with a slash command or skill,
// by looking at the first non-system user_message. Stronger signal than "any
// invocation appears in this session": this means the user invoked a command
// or skill as the very first thing they did.
function deriveStartedWith(events: ParsedEvent[]): Invocation | null {
  for (const evt of events) {
    if (evt.event_type !== 'user_message') continue;
    const meta = evt.metadata;
    if (meta?.subtype === 'system_generated') continue;
    if (meta && typeof meta.command === 'string') {
      // Reset commands (/clear, /compact) don't define the session — keep looking
      // for the first command/skill that actually says what the session is about.
      if (isResetCommandName(meta.command)) continue;
      return { type: 'command', name: meta.command };
    }
    if (meta?.subtype === 'skill_expansion' && typeof meta.skill_name === 'string') {
      return { type: 'skill', name: meta.skill_name };
    }
    return null;
  }
  return null;
}

function deriveInvocations(events: ParsedEvent[]): Invocation[] {
  const seen = new Set<string>();
  const invocations: Invocation[] = [];
  for (const evt of events) {
    if (evt.event_type !== 'user_message' || !evt.metadata) continue;
    const meta = evt.metadata;
    const command = typeof meta.command === 'string' ? meta.command : null;
    if (command) {
      if (isResetCommandName(command)) continue;   // reset commands aren't meaningful invocations
      const key = `command:${command}`;
      if (!seen.has(key)) {
        seen.add(key);
        invocations.push({ type: 'command', name: command });
      }
      continue;
    }
    if (meta.subtype === 'skill_expansion' && typeof meta.skill_name === 'string') {
      const key = `skill:${meta.skill_name}`;
      if (!seen.has(key)) {
        seen.add(key);
        invocations.push({ type: 'skill', name: meta.skill_name });
      }
    }
  }
  return invocations;
}

function deriveProjectPath(messages: TranscriptMessage[]): string {
  for (const msg of messages) {
    if (msg.cwd) return msg.cwd;
  }
  return '';
}

function buildSessionRecord(
  sessionId: string,
  filePath: string,
  messages: TranscriptMessage[],
  model: string | null,
  modelsUsed: string[],
  invocations: Invocation[],
  startedWith: Invocation | null,
  aggregates: ReturnType<typeof computeAggregates>,
  toolCallCount: number,
  subagentCount: number,
  summary: string,
): Session {
  const projectPath = deriveProjectPath(messages);
  const projectName = projectPath ? basename(projectPath) : null;

  // Timestamps from first and last messages
  const startedAt = messages[0].timestamp;
  const endedAt = messages[messages.length - 1].timestamp;
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

  return {
    id: sessionId,
    project_path: projectPath,
    project_name: projectName,
    model,
    models_used: modelsUsed.length > 0 ? JSON.stringify(modelsUsed) : null,
    source: null,
    status: 'imported',
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs > 0 ? durationMs : null,
    total_input_tokens: aggregates.total_input_tokens,
    total_output_tokens: aggregates.total_output_tokens,
    total_cache_read_tokens: aggregates.total_cache_read_tokens,
    total_cache_write_tokens: aggregates.total_cache_write_tokens,
    peak_context_pct: aggregates.peak_context_pct > 0 ? aggregates.peak_context_pct : null,
    compaction_count: aggregates.compaction_count,
    tool_call_count: toolCallCount,
    subagent_count: subagentCount,
    summary,
    end_reason: null,
    transcript_path: filePath,
    metadata: null,
    invocations: invocations.length > 0 ? JSON.stringify(invocations) : null,
    started_with: startedWith ? JSON.stringify(startedWith) : null,
    agent_avg_compression: null,
    agent_total_tokens: 0,
    agent_pressure_events: 0,
    agent_compacted_count: 0,
    peak_concurrency: 0,
  };
}

function findParentTokensAtReturn(
  events: Omit<Event, 'id'>[],
  agentEndTimestamp: string,
): number | null {
  // Find the first event after the agent ended that has input_tokens
  const endTime = new Date(agentEndTimestamp).getTime();
  for (const evt of events) {
    const evtTime = new Date(evt.timestamp).getTime();
    if (evtTime >= endTime && evt.input_tokens != null) {
      return evt.input_tokens;
    }
  }
  // Fall back to the last event with tokens before the agent ended
  let lastTokens: number | null = null;
  for (const evt of events) {
    if (evt.input_tokens != null) {
      lastTokens = evt.input_tokens;
    }
  }
  return lastTokens;
}

function buildEventRecords(
  sessionId: string,
  parsedEvents: ParsedEvent[],
  messages: TranscriptMessage[],
  model: string | null,
): Omit<Event, 'id'>[] {
  // Build a map of timestamp → token snapshot for context_pct enrichment
  const usageByTimestamp = new Map<string, { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; context_pct: number }>();
  for (const msg of messages) {
    if (msg.type === 'assistant' && msg.usage) {
      const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;
      const effectiveContext = msg.usage.input_tokens + cacheRead + cacheWrite;
      usageByTimestamp.set(msg.timestamp, {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        context_pct: estimateContextPct(effectiveContext, model),
      });
    }
  }

  return parsedEvents.map((parsed, index) => {
    // Look up token info for this event's timestamp
    const usage = usageByTimestamp.get(parsed.timestamp);

    return {
      session_id: sessionId,
      agent_id: parsed.agent_id ?? null,
      event_type: parsed.event_type,
      event_source: 'transcript_import' as const,
      tool_name: parsed.tool_name ?? null,
      timestamp: parsed.timestamp,
      sequence_num: index,
      input_tokens: parsed.input_tokens ?? usage?.input_tokens ?? null,
      output_tokens: parsed.output_tokens ?? usage?.output_tokens ?? null,
      cache_read_tokens: parsed.cache_read_tokens ?? usage?.cache_read_tokens ?? null,
      cache_write_tokens: parsed.cache_write_tokens ?? usage?.cache_write_tokens ?? null,
      context_pct: usage?.context_pct ?? null,
      input_preview: parsed.input_preview ?? null,
      input_data: parsed.input_data ?? null,
      output_preview: parsed.output_preview ?? null,
      output_data: parsed.output_data ?? null,
      thinking_summary: parsed.thinking_summary ?? null,
      thinking_text: parsed.thinking_text ?? null,
      duration_ms: (parsed.metadata?.duration_ms as number) ?? null,
      metadata: parsed.metadata ? JSON.stringify(parsed.metadata) : null,
    };
  });
}
