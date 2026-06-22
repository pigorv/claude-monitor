import { Pseudonymizer } from './pseudonymizer.js';

// ── Transcript line sanitizer ───────────────────────────────────────
//
// Allowlist-emit transform over one raw JSONL line. Holds a single
// Pseudonymizer (deterministic pseudonyms stable within one export) and
// a mutable, counts-only AuditSummary. `sanitizeLine` returns the
// sanitized line (a JSON string), a same-length garbage string for
// malformed input, or null when the line is dropped (snapshots / unknown
// types). No source content is ever stored in the audit.

/** Line types we recognize and emit (everything else is dropped). */
const KNOWN_LINE_TYPES = new Set([
  'user',
  'assistant',
  'system',
  'summary',
  'custom-title',
  'ai-title',
]);

/** Tool-input keys whose values are filesystem paths (deterministic pseudonym). */
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path', 'cwd']);

/** Counts-only audit accumulator. Never holds source strings. */
export interface AuditSummary {
  /** Lines emitted (non-null, non-garbage output). */
  emitted: number;
  /** Total lines dropped (snapshots + unknown types). */
  dropped: number;
  /** Per-type breakdown of dropped unknown line types. */
  droppedLines: Record<string, number>;
  /** `file-history-snapshot` lines dropped. */
  droppedSnapshots: number;
  /** Top-level and content-block fields seen but not allowlisted. */
  droppedFields: number;
  /** Values pseudonymized as paths (deterministic). */
  pathsPseudonymized: number;
  /** Free-text values scrambled (non-deterministic, size-preserving). */
  scrambled: number;
  /** Malformed JSON lines replaced with same-length garbage. */
  malformed: number;
}

export interface Sanitizer {
  sanitizeLine(raw: string): string | null;
  readonly audit: AuditSummary;
}

function newAudit(): AuditSummary {
  return {
    emitted: 0,
    dropped: 0,
    droppedLines: {},
    droppedSnapshots: 0,
    droppedFields: 0,
    pathsPseudonymized: 0,
    scrambled: 0,
    malformed: 0,
  };
}

export function createSanitizer(seed?: Buffer): Sanitizer {
  const p = new Pseudonymizer(seed);
  const audit = newAudit();

  function scramble(s: string): string {
    audit.scrambled++;
    return p.scrambleText(s);
  }

  function pseudoPath(s: string): string {
    audit.pathsPseudonymized++;
    return p.pseudonymizePath(s);
  }

  /** Sanitize one tool-input value. JSON keys are kept by the caller. */
  function sanitizeValue(key: string | null, value: unknown): unknown {
    if (value === null) return null;

    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(null, item));
    }

    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = sanitizeValue(k, v);
      }
      return out;
    }

    if (typeof value === 'string') {
      // subagent_type is an agent-tree label, kept verbatim.
      if (key === 'subagent_type') return value;
      // Known path keys, or any string that looks like a path.
      if ((key !== null && PATH_KEYS.has(key)) || value.includes('/')) {
        return pseudoPath(value);
      }
      return scramble(value);
    }

    // number, boolean → keep verbatim.
    return value;
  }

  /** Sanitize a tool_use `input` object: keep every key, transform values. */
  function sanitizeToolInput(input: unknown): unknown {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      // Defensive: inputs are objects in practice, but recurse safely.
      return sanitizeValue(null, input);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = sanitizeValue(k, v);
    }
    return out;
  }

  /** Sanitize one content block, or null if its type is unrecognized. */
  function sanitizeBlock(block: unknown): Record<string, unknown> | null {
    if (typeof block === 'string') {
      // Bare string item in a content array → treat as text.
      return { type: 'text', text: scramble(block) };
    }
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      audit.droppedFields++;
      return null;
    }
    const b = block as Record<string, unknown>;
    const type = b['type'];

    switch (type) {
      case 'thinking': {
        countDroppedKeys(b, new Set(['type', 'thinking', 'signature']));
        const out: Record<string, unknown> = { type: 'thinking' };
        if (typeof b['thinking'] === 'string') out['thinking'] = scramble(b['thinking']);
        // `signature` is intentionally dropped (not re-emitted).
        return out;
      }
      case 'text': {
        countDroppedKeys(b, new Set(['type', 'text']));
        const out: Record<string, unknown> = { type: 'text' };
        if (typeof b['text'] === 'string') out['text'] = scramble(b['text']);
        return out;
      }
      case 'tool_use': {
        countDroppedKeys(b, new Set(['type', 'id', 'name', 'input']));
        const out: Record<string, unknown> = { type: 'tool_use' };
        if (typeof b['id'] === 'string') out['id'] = b['id'];
        if (typeof b['name'] === 'string') out['name'] = p.pseudonymizeMcpName(b['name']);
        if ('input' in b) out['input'] = sanitizeToolInput(b['input']);
        return out;
      }
      case 'tool_result': {
        countDroppedKeys(
          b,
          new Set(['type', 'tool_use_id', 'is_error', 'agentId', 'agentType', 'content']),
        );
        const out: Record<string, unknown> = { type: 'tool_result' };
        if (typeof b['tool_use_id'] === 'string') out['tool_use_id'] = b['tool_use_id'];
        if (typeof b['is_error'] === 'boolean') out['is_error'] = b['is_error'];
        if (typeof b['agentId'] === 'string') out['agentId'] = b['agentId'];
        if (typeof b['agentType'] === 'string') out['agentType'] = b['agentType'];
        const content = b['content'];
        if (typeof content === 'string') {
          out['content'] = scramble(content);
        } else if (Array.isArray(content)) {
          out['content'] = sanitizeContent(content);
        }
        return out;
      }
      default:
        // Unrecognized block type → drop and count.
        audit.droppedFields++;
        return null;
    }
  }

  /** Sanitize a `message.content` value (string or block array). */
  function sanitizeContent(content: unknown): unknown {
    if (typeof content === 'string') {
      return scramble(content);
    }
    if (!Array.isArray(content)) return content;
    const out: Record<string, unknown>[] = [];
    for (const block of content) {
      const sanitized = sanitizeBlock(block);
      if (sanitized !== null) out.push(sanitized);
    }
    return out;
  }

  /** Count keys present on an object that are not in the allowed set. */
  function countDroppedKeys(obj: Record<string, unknown>, allowed: Set<string>): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) audit.droppedFields++;
    }
  }

  /**
   * Rebuild a line object with only allowlisted top-level fields, counting
   * any field present but not allowlisted.
   */
  function sanitizeTopLevel(raw: Record<string, unknown>, type: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const allowed = new Set<string>([
      'type',
      'uuid',
      'parentUuid',
      'timestamp',
      'sessionId',
      'isSidechain',
      'version',
    ]);

    // Common structural fields kept verbatim.
    out['type'] = type;
    if ('uuid' in raw) out['uuid'] = raw['uuid'];
    if ('parentUuid' in raw) out['parentUuid'] = raw['parentUuid'];
    if ('timestamp' in raw) out['timestamp'] = raw['timestamp'];
    if ('sessionId' in raw) out['sessionId'] = raw['sessionId'];
    if ('isSidechain' in raw) out['isSidechain'] = raw['isSidechain'];
    if ('version' in raw) out['version'] = raw['version'];

    // cwd / gitBranch are pseudonymized when present (any line type).
    if ('cwd' in raw) {
      allowed.add('cwd');
      if (typeof raw['cwd'] === 'string') out['cwd'] = pseudoPath(raw['cwd']);
    }
    if ('gitBranch' in raw) {
      allowed.add('gitBranch');
      if (typeof raw['gitBranch'] === 'string') out['gitBranch'] = p.pseudonymizeToken(raw['gitBranch']);
    }

    if (type === 'user' || type === 'assistant') {
      allowed.add('message');
      allowed.add('toolUseResult');
      const message = raw['message'];
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        const m = message as Record<string, unknown>;
        const mout: Record<string, unknown> = {};
        // Structure/measurement fields kept verbatim.
        if ('role' in m) mout['role'] = m['role'];
        if ('model' in m) mout['model'] = m['model'];
        if ('id' in m) mout['id'] = m['id'];
        if ('usage' in m) mout['usage'] = m['usage'];
        if ('content' in m) mout['content'] = sanitizeContent(m['content']);
        // Count message-level fields that aren't allowlisted.
        countDroppedKeys(m, new Set(['role', 'model', 'id', 'usage', 'content']));
        out['message'] = mout;
      }
      // toolUseResult: keep only agentId/agentType (the linker reads these).
      const tur = raw['toolUseResult'];
      if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
        const t = tur as Record<string, unknown>;
        const turOut: Record<string, unknown> = {};
        if (typeof t['agentId'] === 'string') turOut['agentId'] = t['agentId'];
        if (typeof t['agentType'] === 'string') turOut['agentType'] = t['agentType'];
        countDroppedKeys(t, new Set(['agentId', 'agentType']));
        out['toolUseResult'] = turOut;
      }
    } else if (type === 'system') {
      allowed.add('subtype');
      allowed.add('durationMs');
      if ('subtype' in raw) out['subtype'] = raw['subtype'];
      if ('durationMs' in raw) out['durationMs'] = raw['durationMs'];
    } else if (type === 'summary') {
      allowed.add('summary');
      if (typeof raw['summary'] === 'string') out['summary'] = scramble(raw['summary']);
    } else if (type === 'custom-title') {
      allowed.add('customTitle');
      if (typeof raw['customTitle'] === 'string') out['customTitle'] = scramble(raw['customTitle']);
    } else if (type === 'ai-title') {
      allowed.add('aiTitle');
      if (typeof raw['aiTitle'] === 'string') out['aiTitle'] = scramble(raw['aiTitle']);
    }

    // Count every top-level field present but not allowlisted.
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) audit.droppedFields++;
    }

    return out;
  }

  function sanitizeLine(raw: string): string | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      audit.malformed++;
      return p.garbageLine(raw.length);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      audit.malformed++;
      return p.garbageLine(raw.length);
    }

    const type = parsed['type'];

    if (type === 'file-history-snapshot') {
      audit.droppedSnapshots++;
      audit.dropped++;
      return null;
    }

    if (typeof type !== 'string' || !KNOWN_LINE_TYPES.has(type)) {
      const key = typeof type === 'string' ? type : '(missing)';
      audit.droppedLines[key] = (audit.droppedLines[key] ?? 0) + 1;
      audit.dropped++;
      return null;
    }

    const out = sanitizeTopLevel(parsed, type);
    audit.emitted++;
    return JSON.stringify(out);
  }

  return { sanitizeLine, audit };
}
