import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import * as logger from '../shared/logger.js';
import type { ContentBlock, TextBlock, TranscriptMessage, UsageInfo } from '../shared/types.js';

/** Line types that should be skipped during parsing. */
const SKIP_TYPES = new Set(['file-history-snapshot', 'progress']);

/** System subtypes that should be skipped. */
const SKIP_SYSTEM_SUBTYPES = new Set(['turn_duration']);

/**
 * Parse a single JSONL line into a TranscriptMessage, or null if the line
 * should be skipped (non-message line, malformed JSON, etc.).
 */
export function parseLine(line: string): TranscriptMessage | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    logger.warn('Malformed JSON line, skipping', { preview: trimmed.slice(0, 120) });
    return null;
  }

  const type = raw['type'] as string | undefined;
  if (!type) return null;

  // Skip non-message line types
  if (SKIP_TYPES.has(type)) return null;

  // Skip system lines with certain subtypes
  if (type === 'system') {
    const subtype = raw['subtype'] as string | undefined;
    if (subtype && SKIP_SYSTEM_SUBTYPES.has(subtype)) return null;
  }

  // Must have a message wrapper to be a transcript message
  const messageWrapper = raw['message'] as Record<string, unknown> | undefined;
  if (!messageWrapper) return null;

  const rawContent = messageWrapper['content'];
  if (rawContent === undefined || rawContent === null) return null;

  // Normalize content to ContentBlock[]
  const content = normalizeContent(rawContent);

  // Claude Code emits Agent/Task results with a top-level `toolUseResult` that
  // carries `agentId`/`agentType`. Those fields aren't present on the
  // tool_result content block itself, so copy them onto the block so the
  // downstream extractor can read them alongside the result text.
  const toolUseResult = raw['toolUseResult'];
  if (toolUseResult && typeof toolUseResult === 'object') {
    const tur = toolUseResult as Record<string, unknown>;
    const agentId = typeof tur['agentId'] === 'string' ? (tur['agentId'] as string) : undefined;
    const agentType = typeof tur['agentType'] === 'string' ? (tur['agentType'] as string) : undefined;
    if (agentId || agentType) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          if (agentId) block.agentId = agentId;
          if (agentType) block.agentType = agentType;
          break;
        }
      }
    }
  }

  // Extract usage info
  const usage = extractUsage(messageWrapper['usage'] as Record<string, unknown> | undefined);

  // Extract model
  const model = (messageWrapper['model'] as string | undefined) ?? undefined;

  // Extract message ID (for deduplication — multiple JSONL lines share the same API message)
  const messageId = (messageWrapper['id'] as string | undefined) ?? undefined;

  return {
    uuid: raw['uuid'] as string,
    parentUuid: (raw['parentUuid'] as string | null) ?? null,
    type: type as TranscriptMessage['type'],
    timestamp: raw['timestamp'] as string,
    content,
    usage,
    sessionId: (raw['sessionId'] as string | undefined) ?? undefined,
    cwd: (raw['cwd'] as string | undefined) ?? undefined,
    model,
    messageId,
  };
}

/**
 * Normalize raw content (which may be a string, an array of strings,
 * or an array of content blocks) into ContentBlock[].
 */
function normalizeContent(rawContent: unknown): ContentBlock[] {
  if (typeof rawContent === 'string') {
    return [{ type: 'text', text: rawContent } satisfies TextBlock];
  }

  if (!Array.isArray(rawContent)) return [];

  return rawContent.map((item: unknown) => {
    if (typeof item === 'string') {
      return { type: 'text', text: item } satisfies TextBlock;
    }
    // Already a content block object
    return item as ContentBlock;
  });
}

/**
 * Extract the 4 usage fields we care about from the raw usage object.
 */
function extractUsage(rawUsage: Record<string, unknown> | undefined): UsageInfo | undefined {
  if (!rawUsage) return undefined;

  const inputTokens = rawUsage['input_tokens'];
  if (typeof inputTokens !== 'number') return undefined;

  return {
    input_tokens: inputTokens,
    output_tokens: (rawUsage['output_tokens'] as number) ?? 0,
    cache_read_input_tokens: (rawUsage['cache_read_input_tokens'] as number) ?? undefined,
    cache_creation_input_tokens: (rawUsage['cache_creation_input_tokens'] as number) ?? undefined,
  };
}

/**
 * Extract the AI-generated session title from a JSONL transcript file.
 * Scans for lines with type "custom-title" (Claude Code's native format) and
 * returns the last customTitle value found (last wins, so renames override the
 * original). Returns null if none found.
 */
export async function extractAiTitle(filePath: string): Promise<string | null> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let title: string | null = null;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      if (raw['type'] === 'custom-title' && typeof raw['customTitle'] === 'string' && raw['customTitle'].trim()) {
        title = raw['customTitle'].trim();
      }
    } catch {
      // skip malformed lines
    }
  }
  return title;
}

/**
 * Streaming async generator that reads a JSONL transcript file and yields
 * normalized TranscriptMessage objects.
 */
export async function* parseTranscript(filePath: string): AsyncGenerator<TranscriptMessage> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const message = parseLine(line);
    if (message !== null) {
      yield message;
    }
  }
}
