import { basename, dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { getDb } from '../db/connection.js';
import { deleteEventsBySession, insertEvents } from '../db/queries/events.js';
import { sessionExists, upsertSession } from '../db/queries/sessions.js';
import * as logger from '../shared/logger.js';
import type { Event, Session, TranscriptMessage } from '../shared/types.js';
import { parseTranscript } from './jsonl-parser.js';
import { extractAllEvents, mergeToolCallEvents, assignAgentIds, type ParsedEvent } from './thinking-extractor.js';
import { buildTokenSnapshots, computeAggregates, estimateContextPct } from './token-tracker.js';
import { computeRiskAssessment } from '../analysis/risk-scoring.js';
import { generateSessionSummary } from '../analysis/session-summary.js';
import { computeAgentEfficiency, inferExecutionModes, analyzeAgentFileReads } from '../analysis/agent-efficiency.js';
import { getAgentTokenTimeline, updateAgentRelationship } from '../db/queries/sessions.js';
import type { RiskAssessment } from '../shared/types.js';
import { detectAndLinkSessions } from './session-linker.js';

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
      const count = await importSubagentFile(parentSessionId, agentId, filePath);
      logger.info('Imported subagent transcript', { parentSessionId, agentId, events: count });
      return { sessionId: parentSessionId, eventCount: count, skipped: false };
    }
    // Parent not imported yet — skip. It will be picked up when the parent is imported.
    logger.debug('Subagent file skipped (parent not imported yet)', { filePath });
    return { sessionId: '', eventCount: 0, skipped: true };
  }

  // Collect all messages from the file
  const messages: TranscriptMessage[] = [];
  for await (const msg of parseTranscript(filePath)) {
    messages.push(msg);
  }

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
    logger.debug('Session already imported, skipping', { sessionId, filePath });
    return { sessionId, eventCount: 0, skipped: true };
  }

  // Extract events from messages, merge tool start/end, and assign agent IDs
  const rawEvents = extractAllEvents(messages);
  const parsedEvents = mergeToolCallEvents(rawEvents);
  const agentInfos = assignAgentIds(parsedEvents);

  // Build token snapshots
  const model = deriveModel(messages);
  const snapshots = buildTokenSnapshots(messages, model);
  const aggregates = computeAggregates(snapshots);

  // Compute risk assessment
  const riskAssessment = computeRiskAssessment({
    snapshots,
    events: parsedEvents,
    model,
    compactionCount: aggregates.compaction_count,
    subagentCount: parsedEvents.filter(
      (e) => e.event_type === 'tool_call_start' && (e.tool_name === 'Task' || e.tool_name === 'Agent'),
    ).length,
  });

  // Derive top 3 tools
  const toolCounts = new Map<string, number>();
  for (const e of parsedEvents) {
    if (e.event_type === 'tool_call_start' && e.tool_name) {
      toolCounts.set(e.tool_name, (toolCounts.get(e.tool_name) ?? 0) + 1);
    }
  }
  const topTools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name]) => name);

  // Generate summary
  const toolCallCount = parsedEvents.filter((e) => e.event_type === 'tool_call_start').length;
  const subagentCount = parsedEvents.filter(
    (e) => e.event_type === 'tool_call_start' && (e.tool_name === 'Task' || e.tool_name === 'Agent'),
  ).length;
  const durationMs = new Date(messages[messages.length - 1].timestamp).getTime() - new Date(messages[0].timestamp).getTime();
  const summary = generateSessionSummary({
    model,
    durationMs: durationMs > 0 ? durationMs : null,
    toolCallCount,
    topTools,
    compactionCount: aggregates.compaction_count,
    subagentCount,
    peakContextPct: aggregates.peak_context_pct > 0 ? aggregates.peak_context_pct : null,
    riskLevel: riskAssessment.level,
  });

  // Build session record
  const session = buildSessionRecord(sessionId, filePath, messages, model, aggregates, parsedEvents, riskAssessment, summary);

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
    // Insert agent relationships from transcript
    for (const agent of agentInfos) {
      const startMs = new Date(agent.startTimestamp).getTime();
      const endMs = new Date(agent.endTimestamp).getTime();
      db.prepare(`INSERT INTO agent_relationships (
        parent_session_id, child_agent_id, prompt_preview, result_preview,
        prompt_data, result_data, started_at, ended_at, duration_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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

      for (let idx = 0; idx < agentInfos.length; idx++) {
        const agent = agentInfos[idx];
        const agentTimeline = getAgentTokenTimeline(sessionId, agent.agentId);

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

        updateAgentRelationship(sessionId, agent.agentId, {
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
        } as any);
      }
    }

  // After importing the parent, discover and import subagent transcripts
  const subagentEventCount = await importSubagentTranscripts(sessionId, filePath);

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

  for (const filePath of filePaths) {
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
): Promise<number> {
  const subagentFiles = discoverSubagentFiles(parentTranscriptPath);
  if (subagentFiles.length === 0) return 0;

  let totalEvents = 0;

  for (const subFile of subagentFiles) {
    const agentId = basename(subFile, '.jsonl');
    try {
      const count = await importSubagentFile(parentSessionId, agentId, subFile);
      totalEvents += count;
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
): Promise<number> {
  const messages: TranscriptMessage[] = [];
  for await (const msg of parseTranscript(filePath)) {
    messages.push(msg);
  }
  if (messages.length === 0) return 0;

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

  // Clear ALL events for this subagent before inserting transcript data.
  // Previously only deleted hook events, causing duplicates on re-import.
  const db = getDb();
  db.prepare('DELETE FROM events WHERE session_id = ? AND agent_id = ?')
    .run(parentSessionId, agentId);
  if (eventRecords.length > 0) {
    insertEvents(eventRecords);
  }

  // Count tool calls in the subagent
  const toolCallCount = parsedEvents.filter((e) => e.event_type === 'tool_call_start').length;

  // Compute token totals
  let totalInput = 0;
  let totalOutput = 0;
  for (const msg of messages) {
    if (msg.usage) {
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

  // Upsert agent_relationships — update if exists (from parent transcript's assignAgentIds),
  // or insert if this is a new agent not seen in the parent transcript
  const existingRel = db.prepare(
    'SELECT id FROM agent_relationships WHERE parent_session_id = ? AND child_agent_id = ?',
  ).get(parentSessionId, agentId) as { id: number } | undefined;

  if (existingRel) {
    db.prepare(`UPDATE agent_relationships SET
      child_transcript_path = ?,
      tool_call_count = ?,
      input_tokens_total = ?,
      output_tokens_total = ?,
      started_at = COALESCE(started_at, ?),
      ended_at = COALESCE(ended_at, ?),
      duration_ms = COALESCE(duration_ms, ?),
      status = 'completed'
    WHERE id = ?`).run(
      filePath,
      toolCallCount,
      totalInput,
      totalOutput,
      startedAt,
      endedAt,
      durationMs && durationMs > 0 ? durationMs : null,
      existingRel.id,
    );
  } else {
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

    db.prepare(`INSERT INTO agent_relationships (
      parent_session_id, child_agent_id, child_transcript_path,
      prompt_preview, result_preview, prompt_data, result_data,
      started_at, ended_at, duration_ms,
      input_tokens_total, output_tokens_total, tool_call_count, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      parentSessionId,
      agentId,
      filePath,
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

  logger.debug('Imported subagent transcript', {
    parentSessionId,
    agentId,
    events: eventRecords.length,
    toolCalls: toolCallCount,
  });

  return eventRecords.length;
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
  aggregates: ReturnType<typeof computeAggregates>,
  parsedEvents: ParsedEvent[],
  riskAssessment: RiskAssessment,
  summary: string,
): Session {
  const projectPath = deriveProjectPath(messages);
  const projectName = projectPath ? basename(projectPath) : null;

  // Timestamps from first and last messages
  const startedAt = messages[0].timestamp;
  const endedAt = messages[messages.length - 1].timestamp;
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

  // Count tool calls and subagents
  const toolCallCount = parsedEvents.filter((e) => e.event_type === 'tool_call_start').length;
  const subagentCount = parsedEvents.filter(
    (e) => e.event_type === 'tool_call_start' && (e.tool_name === 'Task' || e.tool_name === 'Agent'),
  ).length;

  return {
    id: sessionId,
    project_path: projectPath,
    project_name: projectName,
    model,
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
    risk_score: riskAssessment.score,
    summary,
    end_reason: null,
    transcript_path: filePath,
    metadata: JSON.stringify({ risk_signals: riskAssessment.signals }),
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
  const usageByTimestamp = new Map<string, { input_tokens: number; output_tokens: number; cache_read_tokens: number; context_pct: number }>();
  for (const msg of messages) {
    if (msg.type === 'assistant' && msg.usage) {
      usageByTimestamp.set(msg.timestamp, {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
        cache_read_tokens: msg.usage.cache_read_input_tokens ?? 0,
        context_pct: estimateContextPct(msg.usage.input_tokens, model),
      });
    }
  }

  return parsedEvents.map((parsed, index) => {
    // Look up token info for this event's timestamp
    const usage = usageByTimestamp.get(parsed.timestamp);

    return {
      session_id: sessionId,
      parent_event_id: null,
      agent_id: parsed.agent_id ?? null,
      event_type: parsed.event_type,
      event_source: 'transcript_import' as const,
      tool_name: parsed.tool_name ?? null,
      timestamp: parsed.timestamp,
      sequence_num: index,
      input_tokens: parsed.input_tokens ?? usage?.input_tokens ?? null,
      output_tokens: parsed.output_tokens ?? usage?.output_tokens ?? null,
      cache_read_tokens: parsed.cache_read_tokens ?? usage?.cache_read_tokens ?? null,
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
