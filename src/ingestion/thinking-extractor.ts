import { PREVIEW_LIMITS } from '../shared/constants.js';
import * as logger from '../shared/logger.js';
import type { EventType, TranscriptMessage } from '../shared/types.js';

// ── Event interfaces ────────────────────────────────────────────────

export interface ThinkingEvent {
  thinking_text: string;
  thinking_summary: string;
  timestamp: string;
  sequence_num: number;
}

export interface ParsedEvent {
  event_type: EventType;
  timestamp: string;
  tool_name?: string;
  tool_use_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  thinking_text?: string;
  thinking_summary?: string;
  input_preview?: string;
  input_data?: string;
  output_preview?: string;
  output_data?: string;
  metadata?: Record<string, unknown>;
  agent_id?: string;
}

// ── Extraction functions ────────────────────────────────────────────

/**
 * Extract all thinking blocks from a single message and return ThinkingEvents.
 */
export function extractThinkingBlocks(message: TranscriptMessage): ThinkingEvent[] {
  const events: ThinkingEvent[] = [];
  let seq = 0;

  for (const block of message.content) {
    if (block.type === 'thinking' && block.thinking) {
      events.push({
        thinking_text: block.thinking,
        thinking_summary: truncate(block.thinking, PREVIEW_LIMITS.thinkingSummary),
        timestamp: message.timestamp,
        sequence_num: seq++,
      });
    }
  }

  return events;
}

/**
 * Process a sequence of messages into typed ParsedEvents suitable for
 * storage in the events table.
 */
export function extractAllEvents(messages: TranscriptMessage[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  // Map tool_use_id → tool_use info for matching tool_result blocks
  const pendingToolUses = new Map<string, { tool_name: string; timestamp: string }>();

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      extractAssistantEvents(msg, events, pendingToolUses);
    } else if (msg.type === 'user') {
      extractUserEvents(msg, events, pendingToolUses);
    }
    // system messages are skipped for event extraction
  }

  return events;
}

// ── Internal helpers ────────────────────────────────────────────────

function extractAssistantEvents(
  msg: TranscriptMessage,
  events: ParsedEvent[],
  pendingToolUses: Map<string, { tool_name: string; timestamp: string }>,
): void {
  let hasTextContent = false;

  for (const block of msg.content) {
    switch (block.type) {
      case 'thinking': {
        if (!block.thinking) break;
        events.push({
          event_type: 'thinking',
          timestamp: msg.timestamp,
          thinking_text: block.thinking,
          thinking_summary: truncate(block.thinking, PREVIEW_LIMITS.thinkingSummary),
        });
        break;
      }
      case 'text': {
        hasTextContent = true;
        break;
      }
      case 'tool_use': {
        const inputJson = JSON.stringify(block.input);
        pendingToolUses.set(block.id, { tool_name: block.name, timestamp: msg.timestamp });
        events.push({
          event_type: 'tool_call_start',
          timestamp: msg.timestamp,
          tool_name: block.name,
          tool_use_id: block.id,
          input_preview: truncate(inputJson, PREVIEW_LIMITS.inputPreview),
          input_data: inputJson,
        });
        break;
      }
    }
  }

  if (hasTextContent) {
    const textParts = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');

    const event: ParsedEvent = {
      event_type: 'assistant_message',
      timestamp: msg.timestamp,
      output_preview: truncate(textParts, PREVIEW_LIMITS.outputPreview),
      output_data: textParts,
    };

    if (msg.usage) {
      event.input_tokens = msg.usage.input_tokens;
      event.output_tokens = msg.usage.output_tokens;
      event.cache_read_tokens = msg.usage.cache_read_input_tokens;
      event.cache_write_tokens = msg.usage.cache_creation_input_tokens;
    }

    // Detect special assistant message subtypes
    const textLower = textParts.toLowerCase();
    if (textLower.includes('[request interrupted')) {
      event.metadata = { ...(event.metadata || {}), subtype: 'interrupted' };
    } else if (textParts.trim() === 'No response requested.' || textParts.trim() === 'No response requested') {
      event.metadata = { ...(event.metadata || {}), subtype: 'no_response' };
    }

    events.push(event);
  }
}

function extractUserEvents(
  msg: TranscriptMessage,
  events: ParsedEvent[],
  pendingToolUses: Map<string, { tool_name: string; timestamp: string }>,
): void {
  let hasPlainText = false;

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      const pending = pendingToolUses.get(block.tool_use_id);
      // Skip tool_result blocks with no matching tool_use in this transcript.
      // This happens at session boundaries (e.g. ExitPlanMode) where a rejection
      // from the previous session leaks into the new session's transcript.
      if (!pending) continue;
      const outputStr = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      const isError = 'is_error' in block && block.is_error === true;
      const isRejected = isError && typeof block.content === 'string'
        && block.content.includes('was rejected');
      const endMetadata: Record<string, unknown> = {};
      if (isRejected) endMetadata.permission_status = 'rejected';
      else if (isError) endMetadata.tool_error = true;
      // Claude Code puts the real subagent ID on the tool_result block itself
      // (sibling of `content`) for Agent/Task calls. Capture it so assignAgentIds
      // can match this entry against the subagent transcript file.
      if (typeof block.agentId === 'string') endMetadata.agentId = block.agentId;
      events.push({
        event_type: 'tool_call_end',
        timestamp: msg.timestamp,
        tool_name: pending.tool_name,
        tool_use_id: block.tool_use_id,
        output_preview: truncate(outputStr, PREVIEW_LIMITS.outputPreview),
        output_data: outputStr,
        metadata: Object.keys(endMetadata).length > 0 ? endMetadata : undefined,
      });
      pendingToolUses.delete(block.tool_use_id);
    } else if (block.type === 'text') {
      hasPlainText = true;
    }
  }

  if (hasPlainText) {
    const textParts = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n');

    const { cleanText, metadata } = parseUserMessageTags(textParts);

    events.push({
      event_type: 'user_message',
      timestamp: msg.timestamp,
      input_preview: truncate(cleanText, PREVIEW_LIMITS.inputPreview),
      input_data: textParts,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }
}

/**
 * Parse system tags from user message text, extracting commands and metadata.
 */
function parseUserMessageTags(text: string): { cleanText: string; metadata: Record<string, unknown> } {
  const metadata: Record<string, unknown> = {};
  let cleanText = text;

  // Extract <command-name>/foo</command-name>
  const cmdMatch = text.match(/<command-name>\s*(\/[^<]+)\s*<\/command-name>/);
  if (cmdMatch) {
    metadata.command = cmdMatch[1].trim();
  }

  // Extract <command-message>...</command-message>
  const msgMatch = text.match(/<command-message>([\s\S]*?)<\/command-message>/);
  if (msgMatch) {
    metadata.command_message = msgMatch[1].trim();
  }

  // Extract <command-args>...</command-args>
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch) {
    metadata.command_args = argsMatch[1].trim();
  }

  // Detect system-generated messages
  if (/<local-command-caveat>/.test(text) || /<local-command-stdout>/.test(text) || /<task-notification>/.test(text)) {
    metadata.subtype = 'system_generated';
  }

  // Detect /context command output (contains token usage table)
  if (metadata.subtype === 'system_generated' && /(?:System prompt|Free space|Messages)\s+\d/.test(text)) {
    metadata.context_output = true;
  }

  // Detect skill expansions and extract skill name from path
  if (text.includes('Base directory for this skill:')) {
    metadata.subtype = 'skill_expansion';
    const skillPathMatch = text.match(/Base directory for this skill:\s*\S+\/skills\/([^\s/]+)/);
    if (skillPathMatch) {
      metadata.skill_name = skillPathMatch[1];
    }
  }

  // Strip all system tags from the clean preview text
  cleanText = cleanText
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .trim();

  // If it's a slash command, use the command as the preview
  if (metadata.command && !cleanText) {
    cleanText = metadata.command as string;
    if (metadata.command_message) {
      cleanText += ' ' + metadata.command_message;
    }
  }

  // If clean text is empty after stripping, use a summary
  if (!cleanText && metadata.subtype === 'system_generated') {
    cleanText = '[system message]';
  }
  if (!cleanText && metadata.subtype === 'skill_expansion') {
    cleanText = '[skill expansion]';
  }

  return { cleanText: cleanText || text, metadata };
}

/**
 * Merge tool_call_end events into their matching tool_call_start events.
 * Removes end events from the list and copies output data onto the start.
 */
export function mergeToolCallEvents(events: ParsedEvent[]): ParsedEvent[] {
  const startByToolUseId = new Map<string, ParsedEvent>();

  // Index all tool_call_start events by tool_use_id
  for (const evt of events) {
    if (evt.event_type === 'tool_call_start' && evt.tool_use_id) {
      startByToolUseId.set(evt.tool_use_id, evt);
    }
  }

  // Merge end events into starts, and filter out ends
  const result: ParsedEvent[] = [];
  for (const evt of events) {
    if (evt.event_type === 'tool_call_end' && evt.tool_use_id) {
      const start = startByToolUseId.get(evt.tool_use_id);
      if (start) {
        start.output_preview = evt.output_preview;
        start.output_data = evt.output_data;
        // Merge metadata from end event (permission_status, tool_error, etc.)
        if (evt.metadata) {
          start.metadata = { ...(start.metadata || {}), ...evt.metadata };
        }
        // Calculate duration from timestamps
        const startMs = new Date(start.timestamp).getTime();
        const endMs = new Date(evt.timestamp).getTime();
        if (endMs > startMs) {
          if (!start.metadata) start.metadata = {};
          start.metadata.duration_ms = endMs - startMs;
        }
      } else {
        // Orphaned tool_call_end with no matching start — drop it
        logger.warn('Dropping orphaned tool_call_end (no matching tool_call_start)', {
          tool_use_id: evt.tool_use_id,
          tool_name: evt.tool_name,
        });
      }
      continue; // skip all end events (merged or orphaned)
    }
    result.push(evt);
  }

  return result;
}

/**
 * Assign agent_id to events between Agent/Task tool_call_start and end.
 * Also returns synthetic agent relationship data.
 */
export function assignAgentIds(events: ParsedEvent[]): Array<{
  agentId: string;
  description: string;
  prompt: string;
  subagentType: string;
  startIdx: number;
  endIdx: number;
  startTimestamp: string;
  endTimestamp: string;
  result?: string;
}> {
  const agents: Array<{
    agentId: string;
    description: string;
    prompt: string;
    subagentType: string;
    startIdx: number;
    endIdx: number;
    startTimestamp: string;
    endTimestamp: string;
    result?: string;
  }> = [];

  // Track seen agentIds to merge resumed agents with same ID
  const agentIdMap = new Map<string, number>(); // agentId → index in agents[]

  // Find Agent/Task tool_call_start events that have been merged (have output_data)
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.event_type === 'tool_call_start' && (evt.tool_name === 'Agent' || evt.tool_name === 'Task')) {
      let description = '';
      let prompt = '';
      let subagentType = '';

      try {
        const input = JSON.parse(evt.input_data || '{}');
        description = input.description || input.prompt?.slice(0, 80) || '';
        prompt = input.prompt || '';
        subagentType = input.subagent_type || '';
      } catch { /* ignore */ }

      // Prefer the real subagent ID captured from the tool_result block
      // (see extractUserEvents — it reads `agentId` off the tool_result itself).
      // This lets us match the agent to its on-disk subagents/agent-<id>.jsonl
      // file; without it we'd fall back to a synthetic index and end up
      // inserting a duplicate row when the subagent file later imports.
      const realAgentId = typeof evt.metadata?.agentId === 'string'
        ? (evt.metadata.agentId as string)
        : null;
      const agentId = realAgentId ? `agent-${realAgentId}` : `agent-${i}`;

      // Find the range of events that belong to this agent
      let endIdx = i;

      // If this merged event has output_data, find child events by timestamp
      if (evt.output_data) {
        const durationMs = (evt.metadata?.duration_ms as number) || 0;
        if (durationMs > 0) {
          const endTime = new Date(evt.timestamp).getTime() + durationMs;
          for (let j = i + 1; j < events.length; j++) {
            const childTime = new Date(events[j].timestamp).getTime();
            if (childTime <= endTime) {
              endIdx = j;
            } else {
              break;
            }
          }
        }
      }

      // Set agent_id on child events
      for (let j = i + 1; j <= endIdx; j++) {
        events[j].agent_id = agentId;
      }

      // Store the agent info in the event's metadata
      if (!evt.metadata) evt.metadata = {};
      evt.metadata._synthetic_agent_id = agentId;

      // If this agent was already seen (resumed agent), merge into existing entry
      const existingIdx = agentIdMap.get(agentId);
      if (existingIdx !== undefined) {
        const existing = agents[existingIdx];
        existing.endIdx = endIdx;
        existing.endTimestamp = endIdx > i ? events[endIdx].timestamp : evt.timestamp;
        if (evt.output_data) existing.result = evt.output_data;
        continue;
      }

      agentIdMap.set(agentId, agents.length);
      agents.push({
        agentId,
        description,
        prompt,
        subagentType,
        startIdx: i,
        endIdx,
        startTimestamp: evt.timestamp,
        endTimestamp: endIdx > i ? events[endIdx].timestamp : evt.timestamp,
        result: evt.output_data ?? undefined,
      });
    }
  }

  return agents;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
