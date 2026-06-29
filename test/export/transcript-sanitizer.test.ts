import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSanitizer } from '../../src/export/transcript-sanitizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');

const SEED = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');

function readFixtureLines(name: string): string[] {
  const text = readFileSync(resolve(FIXTURES, name), 'utf-8');
  return text.split('\n').filter((l) => l.trim() !== '');
}

function sanitizeAll(name: string) {
  const lines = readFixtureLines(name);
  const s = createSanitizer(SEED);
  const out = lines.map((l) => s.sanitizeLine(l));
  return { out, audit: s.audit, lines };
}

describe('createSanitizer — allowlist emit (Behavior #5)', () => {
  it('emits only allowlisted top-level fields per line type', () => {
    const s = createSanitizer(SEED);
    const line =
      '{"parentUuid":"p","cwd":"/tmp/project","sessionId":"sess-001","version":"2.1.0","type":"user","userType":"external","extraField":"secret","message":{"role":"user","content":"hi"},"timestamp":"2026-01-01T00:00:00.000Z","uuid":"u1"}';
    const result = s.sanitizeLine(line);
    assert.ok(result !== null);
    const obj = JSON.parse(result as string) as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    assert.deepEqual(keys, [
      'cwd',
      'message',
      'parentUuid',
      'sessionId',
      'timestamp',
      'type',
      'uuid',
      'version',
    ]);
    // Unrecognized top-level fields are absent...
    assert.equal('userType' in obj, false);
    assert.equal('extraField' in obj, false);
    // ...and counted (userType + extraField).
    assert.ok(s.audit.droppedFields >= 2);
  });

  it('drops unknown line types and counts them per-type', () => {
    const s = createSanitizer(SEED);
    const result = s.sanitizeLine('{"type":"progress","uuid":"x","data":"stuff"}');
    assert.equal(result, null);
    assert.equal(s.audit.droppedLines['progress'], 1);
    assert.equal(s.audit.dropped, 1);
    assert.equal(s.audit.emitted, 0);
  });
});

describe('createSanitizer — content is gone (Behavior #6)', () => {
  const SOURCE_STRINGS = [
    'Hello, please read my file.',
    "I'll read that file for you.",
    'The user wants me to read a file. Let me use the Read tool.',
    "export const hello = 'world';",
    'rm -rf /tmp/project/dist',
    'Delete dist folder',
    '/tmp/project',
    'Read project index file',
    'Find the issue in the config file and report back.',
    'I need to read the config file to find the issue.',
    'not-a-number',
    '/home/user/my-project',
    'localhost',
  ];

  for (const fixture of ['happy/sample-session.jsonl', 'happy/sample-agent-transcript.jsonl']) {
    it(`no source content survives verbatim in ${fixture}`, () => {
      const { out } = sanitizeAll(fixture);
      const joined = out.filter((l): l is string => l !== null).join('\n');
      for (const needle of SOURCE_STRINGS) {
        assert.equal(
          joined.includes(needle),
          false,
          `source string leaked into ${fixture}: ${JSON.stringify(needle)}`,
        );
      }
    });
  }
});

describe('createSanitizer — structure preserved (Behavior #7)', () => {
  it('keeps type/uuid/parentUuid/timestamp/sessionId and usage numbers unchanged', () => {
    const s = createSanitizer(SEED);
    const raw =
      '{"parentUuid":"uuid-user-1","cwd":"/tmp/project","sessionId":"sess-001","version":"2.1.0","type":"assistant","message":{"model":"claude-opus-4-6","role":"assistant","content":[{"type":"thinking","thinking":"think","signature":"abc"},{"type":"text","text":"hi"},{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"/tmp/project/index.ts"}}],"usage":{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":500,"cache_creation_input_tokens":100}},"timestamp":"2026-01-01T00:01:05.000Z","uuid":"uuid-asst-1"}';
    const obj = JSON.parse(s.sanitizeLine(raw) as string) as Record<string, unknown>;

    assert.equal(obj['type'], 'assistant');
    assert.equal(obj['uuid'], 'uuid-asst-1');
    assert.equal(obj['parentUuid'], 'uuid-user-1');
    assert.equal(obj['timestamp'], '2026-01-01T00:01:05.000Z');
    assert.equal(obj['sessionId'], 'sess-001');

    const msg = obj['message'] as Record<string, unknown>;
    assert.equal(msg['role'], 'assistant');
    assert.equal(msg['model'], 'claude-opus-4-6');
    assert.deepEqual(msg['usage'], {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 100,
    });

    const content = msg['content'] as Record<string, unknown>[];
    // Block order + types preserved.
    assert.deepEqual(
      content.map((b) => b['type']),
      ['thinking', 'text', 'tool_use'],
    );
    // thinking signature dropped.
    assert.equal('signature' in content[0], false);
    // tool_use.id preserved, built-in name unchanged.
    assert.equal(content[2]['id'], 'tool-1');
    assert.equal(content[2]['name'], 'Read');
    // file_path becomes a deterministic path pseudonym (not verbatim, keeps /+ext).
    const input = content[2]['input'] as Record<string, unknown>;
    const fp = input['file_path'] as string;
    assert.notEqual(fp, '/tmp/project/index.ts');
    assert.ok(fp.startsWith('/'));
    assert.ok(fp.endsWith('.ts'));
  });

  it('keeps subagent_type verbatim and tool-input JSON keys verbatim', () => {
    const s = createSanitizer(SEED);
    const raw =
      '{"type":"assistant","uuid":"u","parentUuid":null,"timestamp":"t","sessionId":"sess","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Task","input":{"subagent_type":"code-reviewer","description":"do stuff","prompt":"review this"}}]}}';
    const obj = JSON.parse(s.sanitizeLine(raw) as string) as Record<string, unknown>;
    const block = (((obj['message'] as Record<string, unknown>)['content']) as Record<string, unknown>[])[0];
    const input = block['input'] as Record<string, unknown>;
    // JSON keys kept verbatim.
    assert.deepEqual(Object.keys(input).sort(), ['description', 'prompt', 'subagent_type']);
    // subagent_type value kept verbatim.
    assert.equal(input['subagent_type'], 'code-reviewer');
    // other values scrambled (not verbatim).
    assert.notEqual(input['description'], 'do stuff');
    assert.notEqual(input['prompt'], 'review this');
  });

  it('keeps toolUseResult.agentId/agentType verbatim and drops other toolUseResult fields', () => {
    const s = createSanitizer(SEED);
    const raw =
      '{"type":"user","uuid":"u","parentUuid":null,"timestamp":"t","sessionId":"sess","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"secret output"}]},"toolUseResult":{"agentId":"ag-1","agentType":"explorer","stdout":"secret"}}';
    const obj = JSON.parse(s.sanitizeLine(raw) as string) as Record<string, unknown>;
    assert.deepEqual(obj['toolUseResult'], { agentId: 'ag-1', agentType: 'explorer' });
  });
});

describe('createSanitizer — drops and malformed (Behavior #8)', () => {
  it('drops file-history-snapshot lines (null) and counts them', () => {
    const s = createSanitizer(SEED);
    const raw =
      '{"type":"file-history-snapshot","messageId":"m","snapshot":{},"isSnapshotUpdate":false}';
    assert.equal(s.sanitizeLine(raw), null);
    assert.equal(s.audit.droppedSnapshots, 1);
  });

  it('replaces malformed JSON with same-length non-JSON garbage and counts it', () => {
    const s = createSanitizer(SEED);
    const raw = 'this is not valid json {{{';
    const result = s.sanitizeLine(raw);
    assert.ok(result !== null);
    assert.equal((result as string).length, raw.length);
    // Garbage is not parseable JSON and contains no '{'.
    assert.throws(() => JSON.parse(result as string));
    assert.equal((result as string).includes('{'), false);
    assert.equal(s.audit.malformed, 1);
  });
});

describe('createSanitizer — audit (Behavior #11)', () => {
  it('is a counts-only object with the expected fields', () => {
    const { audit } = sanitizeAll('happy/sample-session.jsonl');
    // All numeric except the per-type breakdown map.
    for (const key of [
      'emitted',
      'dropped',
      'droppedSnapshots',
      'droppedFields',
      'pathsPseudonymized',
      'scrambled',
      'malformed',
    ] as const) {
      assert.equal(typeof audit[key], 'number', `${key} should be a number`);
    }
    assert.equal(typeof audit.droppedLines, 'object');

    // sample-session: line 2 is a snapshot (dropped), line 12 is malformed,
    // the remaining 10 lines (incl. the system turn_duration and custom-title)
    // are emitted.
    assert.equal(audit.droppedSnapshots, 1);
    assert.equal(audit.malformed, 1);
    assert.equal(audit.emitted, 10);
    assert.ok(audit.pathsPseudonymized > 0);
    assert.ok(audit.scrambled > 0);
  });
});
