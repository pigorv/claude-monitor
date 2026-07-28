import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getDb } from '../db/connection.js';
import { deleteEventsBySession, insertEvents } from '../db/queries/events.js';
import { sessionExists, upsertSession, setSessionImportedMtime, setSessionImportCheckpoint, getSessionImportCheckpoint } from '../db/queries/sessions.js';
import { CONFIG } from '../shared/constants.js';
import { captureCheckpoint, validatePrefix } from './transcript-checkpoint.js';
import * as logger from '../shared/logger.js';
import type { Event, Invocation, Session, TranscriptMessage } from '../shared/types.js';
import { parseTranscript, parseTranscriptWithTitle } from './jsonl-parser.js';
import { extractAllEvents, mergeToolCallEvents, assignAgentIds, type ParsedEvent } from './thinking-extractor.js';
import { buildTokenSnapshots, computeAggregates, estimateContextPct, dedupeByMessageId, type TokenSnapshot } from './token-tracker.js';
import { generateSessionSummary } from '../analysis/session-summary.js';
import { computeAgentEfficiency, inferExecutionModes, analyzeAgentFileReads } from '../analysis/agent-efficiency.js';
import { getAllAgentTokenTimelines, updateAgentRelationship } from '../db/queries/sessions.js';
import { detectAndLinkSessions } from './session-linker.js';
import { sessionCostUsd } from '../shared/cost.js';

// Reset commands that wipe or compact context. They start a session mechanically
// but never describe it, so they're excluded from the fallback title, the
// "started with" pill, and the invocation list.
const RESET_COMMANDS = new Set(['clear', 'compact']);

// ── Test-only fault-injection seam ─────────────────────────────────
//
// Production-inert hook for exercising the incremental self-heal path (Behavior
// #8). When enabled, the incremental write perturbs one parent row after
// inserting the fresh tail, so the post-write self-verify sees a divergence and
// repairs it. Defaults OFF and gates NO real behavior — the incremental write is
// byte-identical to today unless a test flips this on.
let incrementalWriteFaultEnabled = false;

/** Test-only: force the incremental write to corrupt a parent row so the
 *  self-heal path runs. Pass `false` to disable (the default). */
export function __setIncrementalWriteFaultForTest(on: boolean): void {
  incrementalWriteFaultEnabled = on;
}

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
  options: { force?: boolean; incremental?: boolean } = {},
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
  const parseStartMs = Date.now();
  const { messages, title: sessionTitle } = await parseTranscriptWithTitle(filePath);
  const parseElapsedMs = Date.now() - parseStartMs;

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
  const extractStartMs = Date.now();
  const rawEvents = extractAllEvents(messages);
  const parsedEvents = mergeToolCallEvents(rawEvents);
  const agentInfos = assignAgentIds(parsedEvents);
  const extractElapsedMs = Date.now() - extractStartMs;

  // Compute tool call and subagent counts once (used by summary and session record)
  const toolCounts = new Map<string, number>();
  let toolCallCount = 0;
  for (const e of parsedEvents) {
    if (e.event_type === 'tool_call_start') {
      toolCallCount++;
      if (e.tool_name) {
        toolCounts.set(e.tool_name, (toolCounts.get(e.tool_name) ?? 0) + 1);
      }
    }
  }
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);
  const subagentCount = agentInfos.filter((a) => !a.hasFailed).length;

  // Build token snapshots
  const model = deriveModel(messages);
  const snapshots = buildTokenSnapshots(messages, model);
  const aggregates = computeAggregates(snapshots);

  // Assistant turns the token tracker flagged as compactions, with each turn
  // expanded to all of its JSONL line timestamps (a streamed turn shares a
  // messageId across lines whose timestamps differ by ms/s, and the extractor
  // may tag its assistant_message event with an earlier line than the deduped
  // snapshot) plus the pre-drop context captured from the previous snapshot.
  const compactionTurns = buildCompactionTurns(snapshots, messages);

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
  const eventRecords = buildEventRecords(sessionId, parsedEvents, messages, model, compactionTurns);

  // Incremental decision point (kill-switch gated). When both the caller opts in
  // and CONFIG.incrementalImport is on, a valid checkpoint lets us tail-append
  // instead of rewriting the whole session.
  const attemptIncremental = Boolean(options.incremental) && CONFIG.incrementalImport;
  const db = getDb();

  // Compute the incremental plan from READS before opening the write transaction.
  // A null plan (kill-switch off, no session yet, checkpoint missing/invalid, or
  // any defensive mismatch) means the full write below runs byte-identically to
  // today. See computeIncrementalPlan for the disqualifying conditions.
  const plan =
    attemptIncremental && sessionExists(sessionId)
      ? computeIncrementalPlan(db, sessionId, filePath, eventRecords)
      : null;
  // The path actually taken — 'incremental' only when a valid plan was computed.
  const importMode: 'incremental' | 'full' = plan ? 'incremental' : 'full';
  // Set inside the transaction when the incremental self-verify detected a
  // divergence and repaired it via a full reinsert (see below).
  let healed = false;

  // Write to DB in a single transaction
  const writeStartMs = Date.now();
  db.transaction(() => {
    if (plan) {
      // Incremental tail-append. Keep agent_relationships / session_links rows
      // intact (the upserts below and INSERT OR IGNORE links are idempotent, and
      // keeping them preserves each sub-agent's child_imported_mtime so unchanged
      // sub-agents keep skipping). Drop only the volatile parent tail, shift any
      // sub-agent rows up to make room, then insert the fresh tail.
      const { d, delta, parentCount } = plan;
      db.prepare('DELETE FROM events WHERE session_id = ? AND sequence_num >= ? AND sequence_num < ?')
        .run(sessionId, d, parentCount);
      if (delta > 0) {
        // Integer-only sequence_num shift — FTS-safe (input_data/output_data are
        // untouched, so the INSERT/DELETE-only triggers never fire). No-op when
        // there are no sub-agent rows at or above parentCount.
        db.prepare('UPDATE events SET sequence_num = sequence_num + ? WHERE session_id = ? AND sequence_num >= ?')
          .run(delta, sessionId, parentCount);
      }
      upsertSession(session);
      const tail = eventRecords.slice(d);
      if (tail.length > 0) {
        // These already carry sequence_num = d..newParentCount-1 — exactly the
        // slots freed by the delete + shift above.
        insertEvents(tail);
      }
      upsertAgentRelationshipsFromTranscript(db, sessionId, agentInfos);

      // Test-only: corrupt one parent row so the self-verify below fires. No-op
      // in normal operation (flag defaults off, gates nothing real).
      if (incrementalWriteFaultEnabled && plan.newParentCount > 0) {
        db.prepare('UPDATE events SET tool_name = ? WHERE session_id = ? AND sequence_num = ?')
          .run('__t23_injected_fault__', sessionId, plan.newParentCount - 1);
      }

      // Self-verify + self-heal (Behavior #8). Because the parse is cheap we
      // already hold the authoritative full eventRecords in memory. Read back the
      // parent rows' cheap signature columns (no heavy text, no FTS) and compare
      // to the same signature over eventRecords. Any divergence — a diff/shift
      // bug, or the injected fault above — is repaired with a full reinsert in
      // this same transaction, so the committed state is always correct: a bug
      // costs one fallback tick, never a persisted divergence. The subsequent
      // importSubagentTranscripts (force:true) restores sub-agent rows, so the
      // self-heal only needs to guarantee the parent block.
      healed = verifyAndHealParentRows(db, sessionId, plan.newParentCount, eventRecords);
    } else {
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
      upsertAgentRelationshipsFromTranscript(db, sessionId, agentInfos);
    }
  })();
  const writeElapsedMs = Date.now() - writeStartMs;

  // After importing the parent, discover and import subagent transcripts
  const subagentEventCount = await importSubagentTranscripts(sessionId, filePath, { force: options.force });

    // Compute agent efficiency metrics (second pass, after all data is inserted —
    // including subagent transcripts, so the per-agent token timelines are populated)
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

  // Merge agent tokens into the session totals so that
  // parentTokens = sessionTotal - agentTotal yields a correct positive value.
  // Runs exactly once per import, unconditionally — upsertSession() above just
  // RESET total_input_tokens/total_output_tokens to the parent-only aggregate,
  // so this ADDS agent tokens exactly once and never accumulates across imports.
  // It must run regardless of whether a subagent file changed this tick: a
  // re-import that inserts no new subagent events still has token-bearing agent
  // rows whose tokens belong in the session totals. When there are no such rows,
  // the SUM(... WHERE input_tokens_total IS NOT NULL) yields 0 and this is a no-op.
  applyAgentTokenTotals(sessionId);

  // Recompute subagent_count from the now-complete agent_relationships set.
  // Runs unconditionally (not only when new subagent events were inserted) so the
  // count is corrected even on re-imports that insert no new events. Sourcing from
  // discovered/inserted relationships (rather than agentInfos) picks up nested
  // Workflow children, which assignAgentIds never recognizes. For a normal session
  // this equals the old agentInfos-derived count (one row per non-failed Agent/Task).
  db.prepare(`
    UPDATE sessions SET subagent_count = (
      SELECT COUNT(*) FROM agent_relationships
      WHERE parent_session_id = ? AND status != 'failed'
    ) WHERE id = ?
  `).run(sessionId, sessionId);

  // Compute and store the full per-session cost (parent + per-agent), each term
  // priced at its own model. Uses the parent-only `aggregates` (not the session
  // row, which was just mutated by the agent-merge block above) so parent output
  // is not double-counted and parent fresh input is the billed sum.
  const agentCostRows = db
    .prepare(
      `SELECT model, input_tokens_total, output_tokens_total, cache_read_total,
              cache_write_5m_total, cache_write_1h_total
       FROM agent_relationships
       WHERE parent_session_id = ?`,
    )
    .all(sessionId) as Array<{
    model: string | null;
    input_tokens_total: number | null;
    output_tokens_total: number | null;
    cache_read_total: number | null;
    cache_write_5m_total: number | null;
    cache_write_1h_total: number | null;
  }>;

  const parentParts = {
    freshInput: aggregates.total_input_tokens_billed,
    cacheRead: aggregates.total_cache_read_tokens,
    cacheWrite5m: aggregates.total_cache_write_5m_tokens,
    cacheWrite1h: aggregates.total_cache_write_1h_tokens,
    cacheWriteDefault: Math.max(
      0,
      aggregates.total_cache_write_tokens -
        aggregates.total_cache_write_5m_tokens -
        aggregates.total_cache_write_1h_tokens,
    ),
    output: aggregates.total_output_tokens,
  };

  const agentParts = agentCostRows.map((row) => ({
    model: row.model ?? null,
    freshInput: row.input_tokens_total ?? 0,
    cacheRead: row.cache_read_total ?? 0,
    cacheWrite5m: row.cache_write_5m_total ?? 0,
    cacheWrite1h: row.cache_write_1h_total ?? 0,
    output: row.output_tokens_total ?? 0,
  }));

  const cost = sessionCostUsd(model, parentParts, agentParts);
  db.prepare('UPDATE sessions SET cost_estimate_usd = ? WHERE id = ?').run(cost, sessionId);

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

  // Persist the transcript import checkpoint (size + prefix hash + mtime) so a
  // later incremental tick can decide whether the already-imported prefix is
  // byte-identical (tail-append) or was rewritten (full re-parse). Capturing the
  // whole current file is safe here — the full write above is authoritative for
  // exactly these bytes. If the file vanished (capture throws) or we never got an
  // mtime, fall back to persisting the mtime alone rather than breaking the import.
  try {
    if (fileMtimeMs !== null) {
      const { sizeBytes, prefixHash } = captureCheckpoint(filePath);
      setSessionImportCheckpoint(sessionId, { sizeBytes, prefixHash, mtimeMs: fileMtimeMs });
    }
  } catch {
    if (fileMtimeMs !== null) setSessionImportedMtime(sessionId, fileMtimeMs);
  }

  const totalEvents = eventRecords.length + subagentEventCount;
  logger.info('Imported transcript', {
    sessionId,
    events: totalEvents,
    subagentEvents: subagentEventCount,
    filePath,
  });
  logger.debug('Import timing', {
    sessionId,
    mode: healed ? 'incremental-healed' : importMode,
    ...(plan ? { d: plan.d, delta: plan.delta } : {}),
    events: totalEvents,
    parseMs: parseElapsedMs,
    extractMs: extractElapsedMs,
    writeMs: writeElapsedMs,
  });

  return { sessionId, eventCount: totalEvents, skipped: false };
}

/**
 * Merge the session's token-bearing agent tokens into its total_input_tokens /
 * total_output_tokens. Must be called exactly once per import, after
 * upsertSession() has reset those columns to the parent-only aggregate — so it
 * ADDS agent tokens exactly once and never accumulates across imports. It runs
 * regardless of whether any subagent file changed this tick; when the session
 * has no token-bearing agent rows the SUM(... WHERE input_tokens_total IS NOT
 * NULL) yields 0 and the UPDATE is a no-op.
 */
export function applyAgentTokenTotals(sessionId: string): void {
  const db = getDb();
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

// ── Incremental tail-append ────────────────────────────────────────

/**
 * The tail-append plan for an incremental re-import, or `null` to fall back to
 * the full write. All fields index into the CONTIGUOUS parent event block
 * `sequence_num ∈ [0, parentCount)`; sub-agent rows live at/above parentCount.
 */
interface IncrementalPlan {
  /** First divergent parent sequence_num — the prefix `[0, d)` is byte-identical. */
  d: number;
  /** newParentCount - parentCount (>= 0): how far to shift sub-agent rows up. */
  delta: number;
  /** Parent event count currently stored. */
  parentCount: number;
  /** Parent event count in the freshly-parsed transcript (== eventRecords.length). */
  newParentCount: number;
}

/**
 * Signature of a parent event row for the divergence diff. A byte-identical
 * prefix produces identical signatures; the volatile tool-call boundary (a bare
 * tool_call_start whose tool_result arrived later) diverges via its output
 * length, and any appended tail diverges by count. `ilen`/`olen`/`tlen` come
 * from SQL `length()` on the stored side; the in-memory side mirrors them with
 * `String.length` (see recordSignature).
 */
function storedSignature(r: {
  event_type: string;
  agent_id: string | null;
  tool_name: string | null;
  timestamp: string;
  ilen: number;
  olen: number;
  tlen: number;
}): string {
  return [r.event_type, r.agent_id ?? '', r.tool_name ?? '', r.timestamp, r.ilen, r.olen, r.tlen].join(' ');
}

function recordSignature(r: Omit<Event, 'id'>): string {
  return [
    r.event_type,
    r.agent_id ?? '',
    r.tool_name ?? '',
    r.timestamp,
    r.input_data == null ? 0 : r.input_data.length,
    r.output_data == null ? 0 : r.output_data.length,
    r.thinking_text == null ? 0 : r.thinking_text.length,
  ].join(' ');
}

/**
 * Compute the incremental tail-append plan for a session that already exists,
 * from READS only (no writes). Returns `null` on ANY disqualifying condition, in
 * which case the caller runs the full write path unchanged:
 *  - checkpoint missing (no size or prefix hash), or the on-disk prefix no longer
 *    validates (in-place rewrite or file shrink — Behavior #3);
 *  - the parsed parent block shrank below what's stored (defensive);
 *  - the stored parent row count doesn't match parentCount (defensive).
 */
function computeIncrementalPlan(
  db: Database.Database,
  sessionId: string,
  filePath: string,
  eventRecords: Omit<Event, 'id'>[],
): IncrementalPlan | null {
  const cp = getSessionImportCheckpoint(sessionId);
  if (cp?.last_imported_size == null || cp.last_imported_prefix_hash == null) return null;
  if (!validatePrefix(filePath, cp.last_imported_size, cp.last_imported_prefix_hash)) return null;

  // Identify the contiguous parent block. Sub-agent event rows are exactly those
  // whose agent_id has an agent_relationships row with a non-null
  // child_transcript_path; they're numbered above the parent max.
  const subagentIds = (
    db
      .prepare(
        'SELECT child_agent_id FROM agent_relationships WHERE parent_session_id = ? AND child_transcript_path IS NOT NULL',
      )
      .all(sessionId) as { child_agent_id: string }[]
  ).map((r) => r.child_agent_id);

  const totalCount = () =>
    (db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(sessionId) as { c: number }).c;

  let parentCount: number;
  if (subagentIds.length === 0) {
    parentCount = totalCount();
  } else {
    const placeholders = subagentIds.map(() => '?').join(',');
    const firstSub = db
      .prepare(
        `SELECT MIN(sequence_num) AS m FROM events WHERE session_id = ? AND agent_id IN (${placeholders})`,
      )
      .get(sessionId, ...subagentIds) as { m: number | null };
    parentCount = firstSub.m == null ? totalCount() : firstSub.m;
  }

  const newParentCount = eventRecords.length;
  // Parent block shrank — let the full path repair anything odd.
  if (newParentCount < parentCount) return null;

  const stored = db
    .prepare(
      `SELECT sequence_num, event_type, agent_id, tool_name, timestamp,
              COALESCE(length(input_data),0) AS ilen,
              COALESCE(length(output_data),0) AS olen,
              COALESCE(length(thinking_text),0) AS tlen
       FROM events WHERE session_id = ? AND sequence_num < ? ORDER BY sequence_num ASC`,
    )
    .all(sessionId, parentCount) as {
    sequence_num: number;
    event_type: string;
    agent_id: string | null;
    tool_name: string | null;
    timestamp: string;
    ilen: number;
    olen: number;
    tlen: number;
  }[];
  if (stored.length !== parentCount) return null;

  let d = 0;
  while (d < parentCount && d < newParentCount && storedSignature(stored[d]) === recordSignature(eventRecords[d])) {
    d++;
  }
  const delta = newParentCount - parentCount;
  return { d, delta, parentCount, newParentCount };
}

/**
 * Post-incremental-write self-verify + self-heal (Behavior #8). MUST run inside
 * the write transaction, after the incremental writes: reads back the parent
 * rows' cheap signature columns (the same set computeIncrementalPlan diffs on —
 * no heavy text, no FTS) and compares them positionally to the same signature
 * over the authoritative in-memory `eventRecords`. On any mismatch (row-count or
 * a positional signature), repairs the parent block with deleteEventsBySession +
 * full insertEvents in this same tick and logs a warn. Returns true iff a heal
 * happened. This keeps correctness independent of the diff/shift logic being
 * perfect. After the incremental write the parent block occupies
 * `sequence_num ∈ [0, newParentCount)`; sub-agent rows sit at/above it.
 */
function verifyAndHealParentRows(
  db: Database.Database,
  sessionId: string,
  newParentCount: number,
  eventRecords: Omit<Event, 'id'>[],
): boolean {
  const stored = db
    .prepare(
      `SELECT event_type, agent_id, tool_name, timestamp,
              COALESCE(length(input_data),0) AS ilen,
              COALESCE(length(output_data),0) AS olen,
              COALESCE(length(thinking_text),0) AS tlen
       FROM events WHERE session_id = ? AND sequence_num < ? ORDER BY sequence_num ASC`,
    )
    .all(sessionId, newParentCount) as {
    event_type: string;
    agent_id: string | null;
    tool_name: string | null;
    timestamp: string;
    ilen: number;
    olen: number;
    tlen: number;
  }[];

  let diverged = stored.length !== newParentCount;
  if (!diverged) {
    for (let i = 0; i < newParentCount; i++) {
      if (storedSignature(stored[i]) !== recordSignature(eventRecords[i])) {
        diverged = true;
        break;
      }
    }
  }
  if (!diverged) return false;

  // Repair: wipe all events for the session and reinsert the authoritative
  // parent set at sequence_num 0..N-1. Sub-agent rows are re-imported afterward
  // under force, so restoring only the parent block leaves a consistent state.
  logger.warn('Incremental import self-heal: parent rows diverged, repaired via full reinsert', {
    sessionId,
    storedCount: stored.length,
    expectedCount: newParentCount,
  });
  deleteEventsBySession(sessionId);
  if (eventRecords.length > 0) insertEvents(eventRecords);
  return true;
}

/**
 * Upsert agent relationships from the parent transcript (handles resumed agents
 * with the same ID). Shared verbatim by the full and incremental write paths.
 */
function upsertAgentRelationshipsFromTranscript(
  db: Database.Database,
  sessionId: string,
  agentInfos: ReturnType<typeof assignAgentIds>,
): void {
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
      agent.hasFailed ? 'failed' : 'completed',
    );
  }
}

// ── Batch import ───────────────────────────────────────────────────

/**
 * Import multiple transcript files. Returns results for each file.
 */
export async function importTranscripts(
  filePaths: string[],
  options: {
    force?: boolean;
    onProgress?: (p: { processed: number; total: number; result: ImportResult }) => void;
  } = {},
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
    let result: ImportResult;
    try {
      result = await importTranscript(filePath, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to import transcript', { filePath, error: message });
      result = { sessionId: '', eventCount: 0, skipped: true, error: message };
    }
    results.push(result);

    // Report progress against filtered.length (the count actually processed) and
    // yield to the event loop between files so a long batch import doesn't pin it.
    // When run from the background reimport route this keeps concurrent API calls
    // (e.g. /api/reimport/status) responsive; from the CLI it's a cheap no-op.
    options.onProgress?.({ processed: results.length, total: filtered.length, result });
    await new Promise((r) => setImmediate(r));
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
 * discoverSubagentFiles. Subagent files live at any depth under a directory
 * literally named `subagents`:
 *   flat:   {projectDir}/{sessionId}/subagents/agent-*.jsonl
 *   nested: {projectDir}/{sessionId}/subagents/workflows/<runId>/agent-*.jsonl
 * Parent:   {projectDir}/{sessionId}.jsonl
 * Resolve by walking up to the nearest ancestor dir named `subagents` (not a
 * fixed number of hops) and appending .jsonl to the segment above it.
 */
function parentTranscriptPathForSubagent(subFile: string): string {
  const parts = subFile.split(sep);
  const idx = parts.lastIndexOf('subagents');
  if (idx < 1) {
    // No `subagents` ancestor found — fall back to the legacy two-hop behavior.
    return dirname(dirname(subFile)) + '.jsonl';
  }
  return parts.slice(0, idx).join(sep) + '.jsonl'; // .../{sessionId}.jsonl
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
 * Claude Code stores them under {sessionDir}/subagents/ at any depth:
 *   flat:   {sessionDir}/subagents/agent-*.jsonl
 *   nested: {sessionDir}/subagents/workflows/<runId>/agent-*.jsonl
 * The parent transcript is at: {projectDir}/{sessionId}.jsonl
 * The subagent dir is at: {projectDir}/{sessionId}/subagents/
 * Walks the whole subtree so nested Workflow children are picked up too.
 */
export function discoverSubagentFiles(parentTranscriptPath: string): string[] {
  const parentDir = dirname(parentTranscriptPath);
  const parentBasename = basename(parentTranscriptPath, '.jsonl');
  const subagentsDir = join(parentDir, parentBasename, 'subagents');

  if (!existsSync(subagentsDir)) return [];

  const files: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }
  walk(subagentsDir);

  return files.sort();
}

/**
 * Derive a subagent's agent_id from its on-disk path. Flat children keep their
 * bare basename (`agent-x`), matching assignAgentIds' `agent-<id>` from the
 * parent transcript. Nested Workflow children are qualified by their path under
 * `subagents/` so that two files sharing a basename across run dirs
 * (`.../wf-run-01/agent-x.jsonl` vs `.../wf-run-02/agent-x.jsonl`) stay distinct
 * instead of colliding on the (parent_session_id, child_agent_id) key — which
 * would clobber one agent's events and undercount subagents.
 */
export function subagentIdFromPath(parentTranscriptPath: string, subFile: string): string {
  const parentDir = dirname(parentTranscriptPath);
  const parentBasename = basename(parentTranscriptPath, '.jsonl');
  const subagentsDir = resolve(join(parentDir, parentBasename, 'subagents'));
  const rel = relative(subagentsDir, resolve(subFile)).replace(/\.jsonl$/, '');
  // Normalize to POSIX separators so the id is stable across host OSes.
  return rel.split(sep).join('/');
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
    const agentId = subagentIdFromPath(parentTranscriptPath, subFile);
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
  let totalCacheRead = 0;
  let totalCacheWrite5m = 0;
  let totalCacheWrite1h = 0;
  for (const msg of dedupeByMessageId(messages)) {
    if (msg.type === 'assistant' && msg.usage) {
      totalInput += msg.usage.input_tokens;
      totalOutput += msg.usage.output_tokens;
      totalCacheRead += msg.usage.cache_read_input_tokens ?? 0;
      totalCacheWrite5m += msg.usage.cache_creation_5m_input_tokens ?? 0;
      totalCacheWrite1h += msg.usage.cache_creation_1h_input_tokens ?? 0;
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
    // buildEventRecords numbered this subagent's events 0..M-1, but every
    // subagent shares the parent's session_id. Shift them above the session's
    // current max sequence_num (computed AFTER deleting this agent's own rows,
    // so a re-import recomputes from the real max instead of colliding with its
    // stale rows) so sequence_num stays a collision-free per-session total order.
    if (eventRecords.length > 0) {
      const { offset } = db.prepare(
        'SELECT COALESCE(MAX(sequence_num), -1) + 1 AS offset FROM events WHERE session_id = ?',
      ).get(parentSessionId) as { offset: number };
      const offsetRecords = eventRecords.map((r) => ({
        ...r,
        sequence_num: (r.sequence_num ?? 0) + offset,
      }));
      insertEvents(offsetRecords);
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
        cache_read_total = ?,
        cache_write_5m_total = ?,
        cache_write_1h_total = ?,
        model = ?,
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
        totalCacheRead,
        totalCacheWrite5m,
        totalCacheWrite1h,
        model,
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
        input_tokens_total, output_tokens_total,
        cache_read_total, cache_write_5m_total, cache_write_1h_total,
        model, tool_call_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
        totalCacheRead,
        totalCacheWrite5m,
        totalCacheWrite1h,
        model,
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
    total_input_tokens_billed: aggregates.total_input_tokens_billed,
    total_cache_write_5m_tokens: aggregates.total_cache_write_5m_tokens,
    total_cache_write_1h_tokens: aggregates.total_cache_write_1h_tokens,
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

export function findParentTokensAtReturn(
  events: Omit<Event, 'id'>[],
  agentEndTimestamp: string,
): number | null {
  // Find the first event after the agent ended that has input_tokens.
  // Return effective context (input + cache read + cache write) — under prompt
  // caching the bare input_tokens slice is only 1–3 tokens, so it drastically
  // understates the context the agent result actually entered.
  const endTime = new Date(agentEndTimestamp).getTime();
  for (const evt of events) {
    const evtTime = new Date(evt.timestamp).getTime();
    if (evtTime >= endTime && evt.input_tokens != null) {
      return evt.input_tokens + (evt.cache_read_tokens ?? 0) + (evt.cache_write_tokens ?? 0);
    }
  }
  // Fall back to the last event with tokens before the agent ended
  let lastTokens: number | null = null;
  for (const evt of events) {
    if (evt.input_tokens != null) {
      lastTokens = evt.input_tokens + (evt.cache_read_tokens ?? 0) + (evt.cache_write_tokens ?? 0);
    }
  }
  return lastTokens;
}

/**
 * One compacted turn: the post-drop snapshot, every assistant line timestamp
 * belonging to that turn, and the pre-drop context captured from the previous
 * snapshot. Snapshots flag one point per compacted turn (keyed by the deduped
 * last-line timestamp); `timestamps` expands that to all timestamps sharing the
 * turn's messageId so the join against assistant_message events in
 * buildEventRecords matches regardless of which line the extractor tagged the
 * event with. The pre-drop values are captured here because they cannot be
 * recovered from the events table later: the compacted turn's own thinking/tool
 * rows are enriched with the identical post-drop usage, so a backward scan
 * stops on a same-turn sibling and reports a zero-token loss.
 */
interface CompactionTurn {
  timestamps: Set<string>;
  snapshot: TokenSnapshot;
  tokens_before: number;
  context_pct_before: number | null;
  /** Set once an assistant_message event has been re-typed for this turn. */
  matched: boolean;
}

function buildCompactionTurns(
  snapshots: TokenSnapshot[],
  messages: TranscriptMessage[],
): CompactionTurn[] {
  const turns: CompactionTurn[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (!s.is_compaction) continue;
    // Compaction detection requires prevInputTokens > 0, so a preceding
    // snapshot always exists; guard anyway for safety.
    const prev = i > 0 ? snapshots[i - 1] : null;
    const effectiveAfter = s.input_tokens + s.cache_read_tokens + s.cache_write_tokens;
    turns.push({
      timestamps: new Set([s.timestamp]),
      snapshot: s,
      tokens_before: prev
        ? prev.input_tokens + prev.cache_read_tokens + prev.cache_write_tokens
        : effectiveAfter,
      context_pct_before: prev ? prev.context_pct : null,
      matched: false,
    });
  }
  if (turns.length === 0) return turns;

  // Map a message timestamp → its messageId, and a messageId → all its timestamps.
  const timestampToMessageId = new Map<string, string>();
  const messageIdToTimestamps = new Map<string, Set<string>>();
  for (const msg of messages) {
    if (msg.type !== 'assistant' || !msg.messageId) continue;
    timestampToMessageId.set(msg.timestamp, msg.messageId);
    let group = messageIdToTimestamps.get(msg.messageId);
    if (!group) {
      group = new Set();
      messageIdToTimestamps.set(msg.messageId, group);
    }
    group.add(msg.timestamp);
  }

  for (const turn of turns) {
    const messageId = timestampToMessageId.get(turn.snapshot.timestamp);
    const group = messageId ? messageIdToTimestamps.get(messageId) : undefined;
    // No messageId to expand by — keep the snapshot timestamp itself.
    if (group) {
      for (const t of group) turn.timestamps.add(t);
    }
  }
  return turns;
}

function buildEventRecords(
  sessionId: string,
  parsedEvents: ParsedEvent[],
  messages: TranscriptMessage[],
  model: string | null,
  compactionTurns?: CompactionTurn[],
): Omit<Event, 'id'>[] {
  // Build a map of timestamp → token snapshot for context_pct enrichment
  const usageByTimestamp = new Map<string, { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; context_pct: number }>();
  for (const msg of messages) {
    if (msg.type === 'assistant' && msg.usage) {
      const cacheRead = msg.usage.cache_read_input_tokens ?? 0;
      const cacheWrite = msg.usage.cache_creation_input_tokens ?? 0;
      const effectiveContext = msg.usage.input_tokens + cacheRead + cacheWrite;
      // Skip zero-usage messages (e.g. the synthetic all-zero assistant message
      // Claude Code writes at session end). Mirrors the guard in
      // buildTokenSnapshots(). Otherwise its timestamp — shared with a real
      // user message — would stamp context_pct = 0 onto that row.
      if (effectiveContext === 0 && msg.usage.output_tokens === 0) continue;
      usageByTimestamp.set(msg.timestamp, {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        context_pct: estimateContextPct(effectiveContext, model),
      });
    }
  }

  const turnByTimestamp = new Map<string, CompactionTurn>();
  for (const turn of compactionTurns ?? []) {
    for (const ts of turn.timestamps) turnByTimestamp.set(ts, turn);
  }

  const records: Omit<Event, 'id' | 'sequence_num'>[] = parsedEvents.map((parsed) => {
    // Look up token info for this event's timestamp
    const usage = usageByTimestamp.get(parsed.timestamp);

    // Re-type post-drop assistant turns flagged by the token tracker as
    // compactions. Only parent rows are eligible — subagent turns (including
    // window-tagged events carrying an agent_id) are never re-typed — and only
    // the first assistant_message of a turn, so one compaction never yields
    // two compaction rows. The pre-drop context goes into metadata because it
    // is unrecoverable from the events table (see CompactionTurn).
    const turn =
      parsed.event_type === 'assistant_message' && parsed.agent_id == null
        ? turnByTimestamp.get(parsed.timestamp)
        : undefined;
    const isCompaction = turn != null && !turn.matched;
    if (isCompaction) turn.matched = true;

    const metadata = isCompaction
      ? { ...parsed.metadata, compaction: { tokens_before: turn.tokens_before, context_pct_before: turn.context_pct_before } }
      : parsed.metadata;

    return {
      session_id: sessionId,
      agent_id: parsed.agent_id ?? null,
      event_type: isCompaction ? 'compaction' as const : parsed.event_type,
      event_source: 'transcript_import' as const,
      tool_name: parsed.tool_name ?? null,
      timestamp: parsed.timestamp,
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
      metadata: metadata ? JSON.stringify(metadata) : null,
    };
  });

  // A compacted turn with no text block emits no assistant_message event
  // (tool-only turns), so the re-type above never fires for it. Synthesize the
  // compaction row from the snapshot so the chart marker and event-derived
  // counts still match sessions.compaction_count.
  for (const turn of compactionTurns ?? []) {
    if (turn.matched) continue;
    const s = turn.snapshot;
    const synthetic: Omit<Event, 'id' | 'sequence_num'> = {
      session_id: sessionId,
      agent_id: null,
      event_type: 'compaction',
      event_source: 'transcript_import',
      tool_name: null,
      timestamp: s.timestamp,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      cache_read_tokens: s.cache_read_tokens,
      cache_write_tokens: s.cache_write_tokens,
      context_pct: s.context_pct,
      input_preview: null,
      input_data: null,
      output_preview: null,
      output_data: null,
      thinking_summary: null,
      thinking_text: null,
      duration_ms: null,
      metadata: JSON.stringify({ compaction: { tokens_before: turn.tokens_before, context_pct_before: turn.context_pct_before, synthetic: true } }),
    };
    // ISO 8601 timestamps compare lexicographically — splice into order.
    const idx = records.findIndex((r) => r.timestamp > s.timestamp);
    if (idx === -1) records.push(synthetic);
    else records.splice(idx, 0, synthetic);
  }

  return records.map((r, index) => ({ ...r, sequence_num: index }));
}
