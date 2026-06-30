import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findUnknownFields } from '../../src/ingestion/jsonl-schema-manifest.js';

// This test lives IN test/fixtures/, so the fixtures root is its own directory.
const FIXTURES = fileURLToPath(new URL('./', import.meta.url));

interface ScanViolation {
  file: string;
  path: string;
  key: string;
}

/**
 * Scan the whole fixture corpus for unknown structural fields. Mirrors the
 * pii-gate enumeration: recursive readdir, latin1 read (corrupt/non-utf8.jsonl
 * holds raw non-UTF8 bytes and must not throw). Unparseable lines are skipped,
 * not counted — the real parser skips them too.
 */
function scanCorpus(): ScanViolation[] {
  const violations: ScanViolation[] = [];
  const entries = readdirSync(FIXTURES, { recursive: true, encoding: 'utf-8' });
  for (const rel of entries) {
    if (!rel.endsWith('.jsonl')) continue;
    const abs = fileURLToPath(new URL(rel, import.meta.url));
    const text = readFileSync(abs, 'latin1');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Intentionally unparseable line (corrupt/ fixtures) — the parser skips
        // these too, so they are not schema drift.
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      for (const u of findUnknownFields(parsed as Record<string, unknown>)) {
        violations.push({ file: rel, path: u.path, key: u.key });
      }
    }
  }
  return violations;
}

function formatViolations(violations: ScanViolation[]): string {
  return violations.map((v) => `  [${v.path}] ${v.file}: ${v.key}`).join('\n');
}

describe('schema-drift canary: corpus scan', () => {
  it('reports zero unknown fields across the fixture corpus', () => {
    const violations = scanCorpus();
    const STRICT = !!process.env.SCHEMA_DRIFT_STRICT;

    if (violations.length > 0) {
      const report =
        `Schema drift detected (${violations.length} unknown field(s)):\n` +
        formatViolations(violations);
      if (STRICT) {
        // Strict mode (SCHEMA_DRIFT_STRICT=1): fail the build on drift.
        assert.deepEqual(violations, [], report);
      } else {
        // Normal mode: warn but never fail — the canary is a heads-up, not a gate.
        console.warn(report);
      }
      return;
    }

    assert.equal(violations.length, 0);
  });
});

describe('schema-drift canary: detector', () => {
  /** A fully-known assistant record with a text block and a tool_use block. */
  function knownRecord(): Record<string, unknown> {
    return {
      type: 'assistant',
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
  }

  it('returns [] for a fully-known record', () => {
    assert.deepEqual(findUnknownFields(knownRecord()), []);
  });

  it('reports exactly the injected message.usage.__drift key', () => {
    const rec = knownRecord();
    (((rec.message as Record<string, unknown>).usage) as Record<string, unknown>).__drift = 1;

    const unknowns = findUnknownFields(rec);
    assert.deepEqual(unknowns, [{ path: 'message.usage.__drift', key: '__drift' }]);
  });

  it('does not descend into input/thinking/text leaf values', () => {
    const rec: Record<string, unknown> = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'text with words' },
          { type: 'thinking', thinking: 'text with words', signature: 'sig' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { weirdNestedKey: { deep: 1 } } },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    assert.deepEqual(findUnknownFields(rec), []);
  });

  it('accepts novel ephemeral_* granularities under cache_creation', () => {
    const rec: Record<string, unknown> = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation: { ephemeral_30m_input_tokens: 5 },
        },
      },
    };
    assert.deepEqual(findUnknownFields(rec), []);
  });
});
