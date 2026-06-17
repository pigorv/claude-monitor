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

  return parseMessageObject(raw);
}

/**
 * Build a TranscriptMessage from an already-parsed JSON object, or null if the
 * object is not a transcript message (non-message line type, missing wrapper,
 * etc.). Split out of parseLine so callers that already have the parsed object
 * (e.g. the single-pass title parser) can reuse the normalization without a
 * second JSON.parse.
 */
function parseMessageObject(raw: Record<string, unknown>): TranscriptMessage | null {
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
 * Sum every numeric `ephemeral_*` entry in a cache_creation breakdown object.
 * Used as the authoritative-total fallback when the flat top-level field is
 * absent, so unknown/future granularities are still counted (never dropped).
 */
function sumNumericValues(obj: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('ephemeral_') && typeof value === 'number') {
      total += value;
    }
  }
  return total;
}

/**
 * Extract the usage fields we care about from the raw usage object, including
 * the cache_creation 5m/1h split. The combined cache_creation_input_tokens is
 * the authoritative grand total (top-level flat field, else the sum of all
 * numeric ephemeral_* keys) — never reconstructed as only 5m + 1h.
 */
function extractUsage(rawUsage: Record<string, unknown> | undefined): UsageInfo | undefined {
  if (!rawUsage) return undefined;

  const inputTokens = rawUsage['input_tokens'];
  if (typeof inputTokens !== 'number') return undefined;

  const flat =
    typeof rawUsage['cache_creation_input_tokens'] === 'number'
      ? rawUsage['cache_creation_input_tokens']
      : undefined;
  const obj =
    typeof rawUsage['cache_creation'] === 'object' && rawUsage['cache_creation'] !== null
      ? (rawUsage['cache_creation'] as Record<string, unknown>)
      : undefined;

  let cacheCreationTotal: number | undefined;
  let cacheCreation5m: number | undefined;
  let cacheCreation1h: number | undefined;

  if (obj) {
    cacheCreation5m =
      typeof obj['ephemeral_5m_input_tokens'] === 'number'
        ? obj['ephemeral_5m_input_tokens']
        : 0;
    cacheCreation1h =
      typeof obj['ephemeral_1h_input_tokens'] === 'number'
        ? obj['ephemeral_1h_input_tokens']
        : 0;
    cacheCreationTotal = flat ?? sumNumericValues(obj);
  } else {
    cacheCreationTotal = flat;
    // Legacy fallback: infer the split only when no breakdown object exists.
    cacheCreation5m = cacheCreationTotal ?? 0;
    cacheCreation1h = 0;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: (rawUsage['output_tokens'] as number) ?? 0,
    cache_read_input_tokens: (rawUsage['cache_read_input_tokens'] as number) ?? undefined,
    cache_creation_input_tokens: cacheCreationTotal,
    cache_creation_5m_input_tokens: cacheCreation5m,
    cache_creation_1h_input_tokens: cacheCreation1h,
  };
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

/**
 * Single-pass read of a JSONL transcript that collects normalized messages and
 * the session title in one stream, so the import path reads each transcript
 * once. Recognizes two title records Claude Code emits: "custom-title"
 * (customTitle — a user rename) and "ai-title" (aiTitle — the AI-generated
 * title). A user rename always wins over an AI title regardless of order;
 * within each kind the last non-empty value wins; empty/whitespace values are
 * ignored. Returns title: null if neither record yields one.
 */
export async function parseTranscriptWithTitle(
  filePath: string,
): Promise<{ messages: TranscriptMessage[]; title: string | null }> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const messages: TranscriptMessage[] = [];
  let customTitle: string | null = null;
  let aiTitle: string | null = null;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // skip malformed lines silently
      continue;
    }

    if (raw['type'] === 'custom-title' && typeof raw['customTitle'] === 'string' && raw['customTitle'].trim()) {
      customTitle = raw['customTitle'].trim();
    } else if (raw['type'] === 'ai-title' && typeof raw['aiTitle'] === 'string' && raw['aiTitle'].trim()) {
      aiTitle = raw['aiTitle'].trim();
    } else {
      const message = parseMessageObject(raw);
      if (message !== null) messages.push(message);
    }
  }

  return { messages, title: customTitle ?? aiTitle };
}
