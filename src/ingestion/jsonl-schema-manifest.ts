/**
 * JSONL schema manifest — the executable contract describing every field the
 * ingestion pipeline knows about in a Claude Code transcript line.
 *
 * The manifest lists BOTH categories of field:
 *   - "handled": fields the parser (src/ingestion/jsonl-parser.ts) actively
 *     reads and consumes.
 *   - "ignored": fields that appear in real transcripts / the fixture corpus
 *     but the parser intentionally does NOT consume. They are listed so the
 *     drift detector treats their presence as known (zero unknowns) rather than
 *     flagging them.
 * The two categories are split by inline comments so this file is
 * self-documenting.
 *
 * `findUnknownFields(record)` is a pure, bounded detector: given one parsed
 * JSONL object it returns every structural key — and every unrecognized
 * `type`/`subtype` discriminant value — not covered by the manifest, each with
 * a dotted path. A schema-drift "canary" test (a SEPARATE task) imports
 * `findUnknownFields` and scans the fixture corpus expecting ZERO unknowns; a
 * new field surfacing there means the manifest (and likely the parser) needs to
 * catch up.
 */

export interface UnknownField {
  path: string;
  key: string;
}

/** Recognized top-level `type` discriminant values. */
const KNOWN_LINE_TYPES = new Set<string>([
  // handled / parsed
  'user',
  'assistant',
  'system',
  'custom-title',
  'ai-title',
  // skipped (recognized then dropped — see SKIP_TYPES in jsonl-parser.ts)
  'file-history-snapshot',
  'progress',
  // ignored — known Claude Code line type, not in our corpus but pre-listed
  'summary',
]);

/** Recognized `system` line `subtype` discriminant values. */
const KNOWN_SYSTEM_SUBTYPES = new Set<string>([
  // skipped (SKIP_SYSTEM_SUBTYPES in jsonl-parser.ts)
  'turn_duration',
  // ignored — present in corpus. compact_boundary / away_summary are Claude Code
  // marker lines (no `message` wrapper, so the parser skips them at the wrapper
  // check); local_command is a user-command echo.
  'local_command',
  'compact_boundary',
  'away_summary',
]);

/** Recognized top-level envelope keys. */
const KNOWN_TOP_LEVEL = new Set<string>([
  // handled
  'type',
  'uuid',
  'parentUuid',
  'timestamp',
  'message',
  'sessionId',
  'cwd',
  'toolUseResult',
  'subtype',
  'customTitle',
  'aiTitle',
  // ignored — present in corpus / well-known Claude Code envelope fields
  'version',
  'gitBranch',
  'isSidechain',
  'durationMs',
  'summary',
  'messageId',
  'isSnapshotUpdate',
  'snapshot',
  'userType',
  'requestId',
  'leafUuid',
  'isMeta',
  'isCompactSummary',
]);

/** Recognized keys on the `message` wrapper object. */
const KNOWN_MESSAGE = new Set<string>([
  // handled
  'content',
  'id',
  'model',
  'usage',
  // ignored — structural, kept verbatim by the sanitizer, never read by the parser
  'role',
]);

/** Recognized keys on the `message.usage` object. */
const KNOWN_USAGE = new Set<string>([
  // handled
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
  'cache_creation',
  // ignored — present in corpus usage objects
  'service_tier',
  'server_tool_use',
  'inference_geo',
  'iterations',
  'speed',
]);

/**
 * Recognized keys on the `message.usage.cache_creation` breakdown object. Any
 * `ephemeral_*` key is also accepted via the prefix rule below, mirroring the
 * parser's `sumNumericValues` which sums every numeric `ephemeral_*`
 * granularity — so future granularities (e.g. `ephemeral_30m_input_tokens`)
 * must NOT be reported.
 */
const KNOWN_CACHE_CREATION = new Set<string>([
  // handled
  'ephemeral_5m_input_tokens',
  'ephemeral_1h_input_tokens',
]);

/** Prefix rule: any `cache_creation` key starting with this is accepted. */
const EPHEMERAL_PREFIX = 'ephemeral_';

/**
 * Recognized keys across all `message.content[]` block types (the union of the
 * ContentBlock variants in src/shared/types.ts plus the corpus). The block's
 * `input` (tool_use), `content` (tool_result), and `text`/`thinking`/
 * `signature` string payloads are opaque leaves — their presence is known but
 * the detector never descends into them.
 */
const KNOWN_BLOCK = new Set<string>([
  'type',
  'text',
  'thinking',
  'signature',
  'id',
  'name',
  'input',
  'tool_use_id',
  'content',
  'is_error',
  // handled — agent attribution on tool_result blocks: declared on
  // ToolResultBlock (src/shared/types.ts), read by thinking-extractor, and
  // re-emitted by the export sanitizer on derived fixtures.
  'agentId',
  'agentType',
]);

/**
 * Recognized keys inside the top-level `toolUseResult` object. The parser reads
 * exactly these two (jsonl-parser.ts copies them onto the tool_result block),
 * and the export sanitizer strips everything else — so on sanitized fixtures
 * this set is exhaustive by construction. Raw-transcript `toolUseResult`
 * payloads carry arbitrary tool output; the canary only ever sees sanitized
 * fixtures, so a descent here is safe and keeps drift in the two contract
 * fields visible.
 */
const KNOWN_TOOL_USE_RESULT = new Set<string>([
  // handled
  'agentId',
  'agentType',
]);

/** Type guard: a non-null, non-array object usable as a Record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scan a single parsed JSONL object for structural keys (and unrecognized
 * `type`/`subtype` discriminant values) not covered by the manifest.
 *
 * Traversal is bounded: it descends only into `message`, `message.usage`,
 * `message.usage.cache_creation`, each `message.content[]` block, and the
 * top-level `toolUseResult` (whose two contract fields the parser reads). It
 * never recurses into a tool-call block's `input`, into `text`/`thinking`/
 * `signature` values, or into a `tool_result` block's `content` — those carry
 * arbitrary user/tool data, not contract fields.
 *
 * Pure and total: never throws on a malformed record. A non-object
 * `message`/`usage`/`cache_creation` or a non-array `content` is simply treated
 * as nothing to descend into.
 */
export function findUnknownFields(record: unknown): UnknownField[] {
  const unknowns: UnknownField[] = [];
  if (!isRecord(record)) return unknowns;

  // Top-level keys.
  for (const key of Object.keys(record)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      unknowns.push({ path: key, key });
    }
  }

  // toolUseResult — the parser reads agentId/agentType from it; the sanitizer
  // guarantees derived fixtures carry nothing else.
  const toolUseResult = record['toolUseResult'];
  if (isRecord(toolUseResult)) {
    for (const key of Object.keys(toolUseResult)) {
      if (!KNOWN_TOOL_USE_RESULT.has(key)) {
        unknowns.push({ path: `toolUseResult.${key}`, key });
      }
    }
  }

  // Discriminant values.
  const type = record['type'];
  if (typeof type === 'string' && !KNOWN_LINE_TYPES.has(type)) {
    unknowns.push({ path: 'type', key: type });
  }
  if (type === 'system') {
    const subtype = record['subtype'];
    if (typeof subtype === 'string' && !KNOWN_SYSTEM_SUBTYPES.has(subtype)) {
      unknowns.push({ path: 'subtype', key: subtype });
    }
  }

  // message
  const message = record['message'];
  if (isRecord(message)) {
    for (const key of Object.keys(message)) {
      if (!KNOWN_MESSAGE.has(key)) {
        unknowns.push({ path: `message.${key}`, key });
      }
    }

    // message.usage
    const usage = message['usage'];
    if (isRecord(usage)) {
      for (const key of Object.keys(usage)) {
        if (!KNOWN_USAGE.has(key)) {
          unknowns.push({ path: `message.usage.${key}`, key });
        }
      }

      // message.usage.cache_creation
      const cacheCreation = usage['cache_creation'];
      if (isRecord(cacheCreation)) {
        for (const key of Object.keys(cacheCreation)) {
          if (!KNOWN_CACHE_CREATION.has(key) && !key.startsWith(EPHEMERAL_PREFIX)) {
            unknowns.push({ path: `message.usage.cache_creation.${key}`, key });
          }
        }
      }
    }

    // message.content[] blocks (opaque leaves are not descended into)
    const content = message['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        for (const key of Object.keys(block)) {
          if (!KNOWN_BLOCK.has(key)) {
            unknowns.push({ path: `message.content[].${key}`, key });
          }
        }
      }
    }
  }

  return unknowns;
}
