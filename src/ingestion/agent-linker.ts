import type { AgentRelationship } from '../shared/types.js';
import { PREVIEW_LIMITS } from '../shared/constants.js';
import { getDb } from '../db/connection.js';
import * as logger from '../shared/logger.js';
import type { EnrichedHookLine } from './hook-handler.js';

// ── Database helpers ────────────────────────────────────────────────

export function insertAgentRelationship(
  rel: Omit<AgentRelationship, 'id'>,
): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO agent_relationships (
      parent_session_id, child_agent_id, child_transcript_path,
      prompt_preview, result_preview, prompt_data, result_data,
      started_at, ended_at, duration_ms,
      input_tokens_total, output_tokens_total, tool_call_count, status
    ) VALUES (
      @parent_session_id, @child_agent_id, @child_transcript_path,
      @prompt_preview, @result_preview, @prompt_data, @result_data,
      @started_at, @ended_at, @duration_ms,
      @input_tokens_total, @output_tokens_total, @tool_call_count, @status
    )
  `).run(rel);
  return Number(result.lastInsertRowid);
}

export function updateAgentRelationship(
  parentSessionId: string,
  childAgentId: string,
  updates: Partial<Omit<AgentRelationship, 'id' | 'parent_session_id' | 'child_agent_id'>>,
): boolean {
  const db = getDb();
  const setClauses: string[] = [];
  const params: Record<string, unknown> = {
    parent_session_id: parentSessionId,
    child_agent_id: childAgentId,
  };

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = @${key}`);
    params[key] = value;
  }

  if (setClauses.length === 0) return false;

  const result = db.prepare(
    `UPDATE agent_relationships SET ${setClauses.join(', ')}
     WHERE parent_session_id = @parent_session_id AND child_agent_id = @child_agent_id`,
  ).run(params);
  return result.changes > 0;
}

export function getAgentRelationship(
  parentSessionId: string,
  childAgentId: string,
): AgentRelationship | undefined {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM agent_relationships WHERE parent_session_id = ? AND child_agent_id = ?',
    )
    .get(parentSessionId, childAgentId) as AgentRelationship | undefined;
}

// ── Preview helper ──────────────────────────────────────────────────

function truncate(value: unknown, limit: number): string | null {
  if (value === null || value === undefined) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > limit ? str.slice(0, limit) + '…' : str;
}

// ── Event handlers ──────────────────────────────────────────────────

export function handleSubagentStart(parsed: EnrichedHookLine): void {
  const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id : null;
  if (!agentId) {
    logger.warn('subagent_start missing agent_id', {
      session_id: parsed.session_id,
    });
    return;
  }

  // Check for duplicate
  const existing = getAgentRelationship(parsed.session_id, agentId);
  if (existing) {
    logger.debug('Agent relationship already exists', {
      session_id: parsed.session_id,
      agent_id: agentId,
    });
    return;
  }

  const promptStr = typeof parsed.prompt === 'string' ? parsed.prompt : null;

  try {
    insertAgentRelationship({
      parent_session_id: parsed.session_id,
      child_agent_id: agentId,
      child_transcript_path: null,
      prompt_preview: truncate(promptStr, PREVIEW_LIMITS.inputPreview),
      result_preview: null,
      prompt_data: promptStr,
      result_data: null,
      started_at: parsed._captured_at,
      ended_at: null,
      duration_ms: null,
      input_tokens_total: null,
      output_tokens_total: null,
      tool_call_count: 0,
      status: 'running',
    });
    logger.debug('Created agent relationship', {
      session_id: parsed.session_id,
      agent_id: agentId,
    });
  } catch (err) {
    logger.error('Failed to insert agent relationship', {
      session_id: parsed.session_id,
      agent_id: agentId,
      error: String(err),
    });
  }
}

export function handleSubagentStop(parsed: EnrichedHookLine): void {
  const agentId = typeof parsed.agent_id === 'string' ? parsed.agent_id : null;
  if (!agentId) {
    logger.warn('subagent_stop missing agent_id', {
      session_id: parsed.session_id,
    });
    return;
  }

  const existing = getAgentRelationship(parsed.session_id, agentId);

  const resultStr =
    typeof parsed.last_assistant_message === 'string'
      ? parsed.last_assistant_message
      : null;
  const transcriptPath =
    typeof parsed.agent_transcript_path === 'string'
      ? parsed.agent_transcript_path
      : null;

  if (!existing) {
    // No matching start — create a completed record directly
    logger.debug('subagent_stop without prior start, creating record', {
      session_id: parsed.session_id,
      agent_id: agentId,
    });
    try {
      insertAgentRelationship({
        parent_session_id: parsed.session_id,
        child_agent_id: agentId,
        child_transcript_path: transcriptPath,
        prompt_preview: null,
        result_preview: truncate(resultStr, PREVIEW_LIMITS.outputPreview),
        prompt_data: null,
        result_data: resultStr,
        started_at: null,
        ended_at: parsed._captured_at,
        duration_ms: null,
        input_tokens_total: null,
        output_tokens_total: null,
        tool_call_count: 0,
        status: 'completed',
      });
    } catch (err) {
      logger.error('Failed to insert agent relationship on stop', {
        session_id: parsed.session_id,
        agent_id: agentId,
        error: String(err),
      });
    }
    return;
  }

  // Update existing record
  const startedAt = existing.started_at
    ? new Date(existing.started_at).getTime()
    : null;
  const endedAt = new Date(parsed._captured_at).getTime();
  const durationMs =
    startedAt !== null && endedAt > startedAt ? endedAt - startedAt : null;

  try {
    updateAgentRelationship(parsed.session_id, agentId, {
      child_transcript_path: transcriptPath,
      result_preview: truncate(resultStr, PREVIEW_LIMITS.outputPreview),
      result_data: resultStr,
      ended_at: parsed._captured_at,
      duration_ms: durationMs,
      status: 'completed',
    });
    logger.debug('Updated agent relationship on stop', {
      session_id: parsed.session_id,
      agent_id: agentId,
      duration_ms: durationMs,
    });
  } catch (err) {
    logger.error('Failed to update agent relationship', {
      session_id: parsed.session_id,
      agent_id: agentId,
      error: String(err),
    });
  }
}
