import type { Event, EventType, Session } from '../shared/types.js';
import { PREVIEW_LIMITS } from '../shared/constants.js';
import { getSession, updateSession, upsertSession } from '../db/queries/sessions.js';
import { handleSubagentStart, handleSubagentStop } from './agent-linker.js';
import * as logger from '../shared/logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface EnrichedHookLine {
  _event_type: string;
  _captured_at: string;
  _capture_version: string;
  session_id: string;
  [key: string]: unknown;
}

// ── Event type mapping ───────────────────────────────────────────────

const EVENT_TYPE_MAP: Record<string, EventType> = {
  pre_tool_use: 'tool_call_start',
  post_tool_use: 'tool_call_end',
  session_start: 'session_start',
  session_end: 'session_end',
  pre_compact: 'compaction',
  subagent_start: 'subagent_start',
  subagent_stop: 'subagent_end',
};

export function mapEventType(hookType: string): EventType | null {
  return EVENT_TYPE_MAP[hookType] ?? null;
}

// ── Parse ────────────────────────────────────────────────────────────

export function parseHookLine(line: string): EnrichedHookLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);

    if (
      typeof parsed._event_type !== 'string' ||
      typeof parsed._captured_at !== 'string' ||
      typeof parsed.session_id !== 'string'
    ) {
      logger.warn('Hook line missing required fields', { line: trimmed.slice(0, 100) });
      return null;
    }

    return parsed as EnrichedHookLine;
  } catch {
    logger.warn('Failed to parse hook line', { line: trimmed.slice(0, 100) });
    return null;
  }
}

// ── Preview helpers ──────────────────────────────────────────────────

function truncate(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > limit ? str.slice(0, limit) + '…' : str;
}

function safeStringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return null;
  }
}

// ── Build Event ──────────────────────────────────────────────────────

export function buildEventFromHook(parsed: EnrichedHookLine): Omit<Event, 'id'> | null {
  const eventType = mapEventType(parsed._event_type);
  if (!eventType) {
    logger.debug('Unknown hook event type', { type: parsed._event_type });
    return null;
  }

  const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : null;

  const inputData = safeStringify(parsed.tool_input ?? null);
  const outputData = safeStringify(parsed.tool_response ?? parsed.last_assistant_message ?? null);

  return {
    session_id: parsed.session_id,
    parent_event_id: null,
    agent_id: typeof parsed.agent_id === 'string' ? parsed.agent_id : null,
    event_type: eventType,
    event_source: 'hook',
    tool_name: toolName,
    timestamp: parsed._captured_at,
    sequence_num: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    context_pct: null,
    input_preview: truncate(parsed.tool_input, PREVIEW_LIMITS.inputPreview),
    input_data: inputData,
    output_preview: truncate(parsed.tool_response ?? parsed.last_assistant_message, PREVIEW_LIMITS.outputPreview),
    output_data: outputData,
    thinking_summary: null,
    thinking_text: null,
    duration_ms: null,
    metadata: null,
  };
}

// ── Session lifecycle ────────────────────────────────────────────────

export function handleSessionEvent(parsed: EnrichedHookLine): void {
  const { _event_type, session_id } = parsed;

  try {
    switch (_event_type) {
      case 'session_start': {
        const projectPath = typeof parsed.cwd === 'string' ? parsed.cwd : '';
        const projectName = projectPath ? projectPath.split('/').pop() ?? null : null;
        const session: Session = {
          id: session_id,
          project_path: projectPath,
          project_name: projectName,
          model: typeof parsed.model === 'string' ? parsed.model : null,
          source: typeof parsed.source === 'string' ? parsed.source : null,
          status: 'running',
          started_at: parsed._captured_at,
          ended_at: null,
          duration_ms: null,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cache_read_tokens: 0,
          total_cache_write_tokens: 0,
          peak_context_pct: null,
          compaction_count: 0,
          tool_call_count: 0,
          subagent_count: 0,
          risk_score: null,
          summary: null,
          end_reason: null,
          transcript_path: typeof parsed.transcript_path === 'string' ? parsed.transcript_path : null,
          metadata: null,
        };
        upsertSession(session);
        break;
      }

      case 'session_end': {
        const existing = getSession(session_id);
        if (!existing) {
          logger.warn('session_end for unknown session', { session_id });
          break;
        }
        const startedAt = new Date(existing.started_at).getTime();
        const endedAt = new Date(parsed._captured_at).getTime();
        const durationMs = endedAt > startedAt ? endedAt - startedAt : null;
        updateSession(session_id, {
          status: 'completed',
          ended_at: parsed._captured_at,
          duration_ms: durationMs,
          end_reason: typeof parsed.reason === 'string' ? parsed.reason : null,
        });
        break;
      }

      case 'pre_compact': {
        const existing = getSession(session_id);
        if (existing) {
          updateSession(session_id, {
            compaction_count: existing.compaction_count + 1,
          });
        }
        break;
      }

      case 'pre_tool_use': {
        const existing = getSession(session_id);
        if (existing) {
          updateSession(session_id, {
            tool_call_count: existing.tool_call_count + 1,
          });
        }
        break;
      }

      case 'subagent_start': {
        const existing = getSession(session_id);
        if (existing) {
          updateSession(session_id, {
            subagent_count: existing.subagent_count + 1,
          });
        }
        handleSubagentStart(parsed);
        break;
      }

      case 'subagent_stop': {
        handleSubagentStop(parsed);
        break;
      }
    }
  } catch (err) {
    logger.error('Failed to handle session event', {
      event_type: _event_type,
      session_id,
      error: String(err),
    });
  }
}

// ── Main entry point ─────────────────────────────────────────────────

export function processHookLine(line: string): Omit<Event, 'id'> | null {
  const parsed = parseHookLine(line);
  if (!parsed) return null;

  handleSessionEvent(parsed);
  return buildEventFromHook(parsed);
}
