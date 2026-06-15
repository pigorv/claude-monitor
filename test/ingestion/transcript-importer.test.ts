import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { importTranscript, importTranscripts, filterCoveredSubagents } from '../../src/ingestion/transcript-importer.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { getSession, sessionExists } from '../../src/db/queries/sessions.js';
import { listEventsBySession, getTokenTimeline } from '../../src/db/queries/events.js';

const TEST_DIR = join(tmpdir(), `claude-monitor-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, 'test.sqlite');

// ── Sample JSONL content ───────────────────────────────────────────

const SAMPLE_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Hello, please read my file.' },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'uuid-user-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-user-1', cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The user wants me to read a file.' },
        { type: 'text', text: "I'll read that file for you." },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/project/index.ts' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'uuid-asst-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-asst-1', cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: "export const hello = 'world';" }] },
    timestamp: '2026-01-01T00:01:06.000Z', uuid: 'uuid-user-2',
  }),
  JSON.stringify({
    parentUuid: 'uuid-user-2', cwd: '/tmp/project', sessionId: 'test-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'The file contains a simple export.' }],
      usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:10.000Z', uuid: 'uuid-asst-2',
  }),
].join('\n');

// ── Tests ──────────────────────────────────────────────────────────

describe('importTranscript', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports a transcript and creates session + events', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    const result = await importTranscript(filePath);

    assert.equal(result.sessionId, 'test-session-1');
    assert.equal(result.skipped, false);
    assert.ok(result.eventCount > 0);

    // Verify session in DB
    const session = getSession('test-session-1');
    assert.ok(session);
    assert.equal(session.project_path, '/tmp/project');
    assert.equal(session.project_name, 'project');
    assert.equal(session.model, 'claude-opus-4-6');
    assert.equal(session.status, 'imported');
    assert.equal(session.started_at, '2026-01-01T00:01:00.000Z');
    assert.equal(session.ended_at, '2026-01-01T00:01:10.000Z');
    assert.ok(session.duration_ms! > 0);
    assert.equal(session.total_input_tokens, 2300); // max effective context (input + cache_read + cache_write)
    assert.equal(session.total_output_tokens, 250); // 200 + 50
    assert.equal(session.total_cache_read_tokens, 1300); // 500 + 800
    assert.equal(session.tool_call_count, 1); // Read tool
    assert.equal(session.transcript_path, filePath);
  });

  it('is idempotent — skips already-imported sessions', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    const first = await importTranscript(filePath);
    assert.equal(first.skipped, false);

    const second = await importTranscript(filePath);
    assert.equal(second.skipped, true);
    assert.equal(second.eventCount, 0);
  });

  it('re-imports with force flag', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);
    const second = await importTranscript(filePath, { force: true });
    assert.equal(second.skipped, false);
    assert.ok(second.eventCount > 0);
  });

  it('creates events with correct types', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const { events } = listEventsBySession('test-session-1', { includeThinking: true });
    const types = events.map((e) => e.event_type);

    assert.ok(types.includes('user_message'));
    assert.ok(types.includes('thinking'));
    assert.ok(types.includes('assistant_message'));
    assert.ok(types.includes('tool_call_start'));
    // tool_call_end events are now merged into tool_call_start
  });

  it('stores token data on events', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const { events } = listEventsBySession('test-session-1');
    const assistantEvents = events.filter((e) => e.event_type === 'assistant_message');

    assert.ok(assistantEvents.length > 0);
    const first = assistantEvents[0];
    assert.ok(first.input_tokens !== null);
    assert.ok(first.context_pct !== null);
  });

  it('assigns sequential sequence numbers', async () => {
    const filePath = join(TEST_DIR, 'session.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const { events } = listEventsBySession('test-session-1');
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].sequence_num, i);
    }
  });

  it('returns error for empty file', async () => {
    const filePath = join(TEST_DIR, 'empty.jsonl');
    writeFileSync(filePath, '');

    const result = await importTranscript(filePath);
    assert.equal(result.skipped, true);
    assert.ok(result.error?.includes('No messages'));
  });

  it('derives session ID from filename when no sessionId in messages', async () => {
    const jsonl = JSON.stringify({
      parentUuid: null, cwd: '/tmp/proj', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
    });

    const filePath = join(TEST_DIR, 'custom-session-id.jsonl');
    writeFileSync(filePath, jsonl);

    const result = await importTranscript(filePath);
    assert.equal(result.sessionId, 'custom-session-id');
    assert.equal(result.skipped, false);
  });

  it('uses AI title as summary when custom-title line is present', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'title-session', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Hello, please read my file.' },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'uuid-user-1',
      }),
      JSON.stringify({
        parentUuid: 'uuid-user-1', cwd: '/tmp/project', sessionId: 'title-session', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 1000, output_tokens: 50 },
        },
        timestamp: '2026-01-01T00:01:05.000Z', uuid: 'uuid-asst-1',
      }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Read project files', sessionId: 'title-session' }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'title-session.jsonl');
    writeFileSync(filePath, jsonl);

    const result = await importTranscript(filePath);
    assert.equal(result.skipped, false);

    const session = getSession('title-session');
    assert.ok(session);
    assert.equal(session.summary, 'Read project files');
  });

  it('prefers a plain-text user message over a leading /clear for the fallback title', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'fallback-plain', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'fallback-plain', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Fix the broken login flow' },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'fallback-plain', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'On it.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'fallback-plain.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('fallback-plain');
    assert.ok(session);
    assert.equal(session.summary, 'Fix the broken login flow');
  });

  it('falls back to the first non-reset slash command when there is no plain-text user message', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'fallback-slash', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'fallback-slash', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/review</command-name>' }] },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'fallback-slash', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Reviewing.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'fallback-slash.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('fallback-slash');
    assert.ok(session);
    assert.equal(session.summary, '/review');
  });

  it('keeps the opening slash command as the title when plain text only comes later', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'cmd-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/dev-flow</command-name>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'cmd-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'yes, go ahead' },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'cmd-first', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Proceeding.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'cmd-first.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('cmd-first');
    assert.ok(session);
    assert.equal(session.summary, '/dev-flow');
  });

  it('keeps the opening plain text as the title when a slash command only comes later', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'text-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Speed up the importer' },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'text-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/review</command-name>' }] },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'text-first', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'On it.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'text-first.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('text-first');
    assert.ok(session);
    assert.equal(session.summary, 'Speed up the importer');
  });

  it('never titles a session from a skill-expansion message', async () => {
    // The expansion is the first candidate the fallback loop reaches (the
    // leading /clear is reset-skipped), so this fails if the skill_expansion
    // exclusion is removed from the importer.
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'skill-expansion', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'skill-expansion', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/user/.claude/skills/code-review\n\n# Code review\n\nYou review pre-merge work.' }] },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'skill-expansion', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Fix the login flow' },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'u-3',
      }),
      JSON.stringify({
        parentUuid: 'u-3', cwd: '/tmp/project', sessionId: 'skill-expansion', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Reviewing.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:03.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'skill-expansion.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('skill-expansion');
    assert.ok(session);
    assert.equal(session.summary, 'Fix the login flow');
  });

  it('never titles a session from system-reminder or task-notification messages', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'synthetic-msgs', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>Plan mode is active.</system-reminder>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'synthetic-msgs', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<task-notification>Agent completed</task-notification>' }] },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'synthetic-msgs', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Refactor the importer' },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'u-3',
      }),
      JSON.stringify({
        parentUuid: 'u-3', cwd: '/tmp/project', sessionId: 'synthetic-msgs', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'On it.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:03.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'synthetic-msgs.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('synthetic-msgs');
    assert.ok(session);
    assert.equal(session.summary, 'Refactor the importer');
  });

  it('never titles a session from an interrupt marker', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'interrupt-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'interrupt-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Resume the migration work' },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'interrupt-first', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Resuming.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'interrupt-first.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('interrupt-first');
    assert.ok(session);
    assert.equal(session.summary, 'Resume the migration work');
  });

  it('excludes /compact from the fallback title and started_with like /clear', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'compact-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/compact</command-name>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'compact-first', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Tidy up the token tracker' },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'compact-first', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'compact-first.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('compact-first');
    assert.ok(session);
    assert.equal(session.summary, 'Tidy up the token tracker');
    assert.equal(session.started_with, null);
    assert.equal(session.invocations, null, '/compact should not be an invocation');
  });

  it('falls back to a generated summary when the only user messages are reset commands', async () => {
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'reset-only', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'reset-only', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Cleared.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'reset-only.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const session = getSession('reset-only');
    assert.ok(session);
    assert.match(session.summary!, /^Opus session/, 'expected the generated stats summary');
    assert.ok(!session.summary!.includes('/clear'), 'reset command must not become the title');
    assert.equal(session.started_with, null);
    assert.equal(session.invocations, null, 'reset-only sessions should have no invocations');
  });
});

describe('importTranscripts (batch)', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports multiple files', async () => {
    const file1 = join(TEST_DIR, 'sess-a.jsonl');
    const file2 = join(TEST_DIR, 'sess-b.jsonl');

    const jsonl1 = JSON.stringify({
      parentUuid: null, cwd: '/tmp/a', sessionId: 'sess-a', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
    });
    const jsonl2 = JSON.stringify({
      parentUuid: null, cwd: '/tmp/b', sessionId: 'sess-b', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-02T00:00:00.000Z', uuid: 'u2',
    });

    writeFileSync(file1, jsonl1);
    writeFileSync(file2, jsonl2);

    const results = await importTranscripts([file1, file2]);
    assert.equal(results.length, 2);
    assert.ok(sessionExists('sess-a'));
    assert.ok(sessionExists('sess-b'));
  });

  it('handles errors in individual files gracefully', async () => {
    const goodFile = join(TEST_DIR, 'good.jsonl');
    const badFile = join(TEST_DIR, 'nonexistent.jsonl');

    writeFileSync(goodFile, JSON.stringify({
      parentUuid: null, cwd: '/tmp/x', sessionId: 'good-sess', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z', uuid: 'u1',
    }));

    const results = await importTranscripts([goodFile, badFile]);
    assert.equal(results.length, 2);
    assert.equal(results[0].skipped, false);
    assert.equal(results[1].skipped, true);
    assert.ok(results[1].error);
  });
});

describe('importTranscript with sample fixture', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('imports the sample-session.jsonl fixture', async () => {
    const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'sample-session.jsonl');

    const result = await importTranscript(fixturePath);
    assert.equal(result.sessionId, 'sess-001');
    assert.equal(result.skipped, false);
    assert.ok(result.eventCount > 0);

    const session = getSession('sess-001');
    assert.ok(session);
    assert.equal(session.model, 'claude-opus-4-6');
    assert.equal(session.project_path, '/tmp/project');
    assert.equal(session.tool_call_count, 3);

    // Token timeline should have data points
    const timeline = getTokenTimeline('sess-001');
    assert.ok(timeline.length > 0);
  });
});

// ── Invocations aggregation ────────────────────────────────────────

const INVOCATIONS_JSONL = [
  // /review command (first appearance)
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '<command-name>/review</command-name>\n<command-message>review</command-message>' }] },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
  }),
  JSON.stringify({
    parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Reviewing.' }],
      usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:01.000Z', uuid: 'a-1',
  }),
  // skill expansion
  JSON.stringify({
    parentUuid: 'a-1', cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/user/.claude/skills/debug-pipeline\n\nDebug the pipeline' }] },
    timestamp: '2026-01-01T00:01:02.000Z', uuid: 'u-2',
  }),
  JSON.stringify({
    parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Debugging.' }],
      usage: { input_tokens: 1100, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:03.000Z', uuid: 'a-2',
  }),
  // plain user message — must be ignored
  JSON.stringify({
    parentUuid: 'a-2', cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'just a normal question' },
    timestamp: '2026-01-01T00:01:04.000Z', uuid: 'u-3',
  }),
  JSON.stringify({
    parentUuid: 'u-3', cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Sure.' }],
      usage: { input_tokens: 1200, output_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'a-3',
  }),
  // duplicate /review — must be deduped
  JSON.stringify({
    parentUuid: 'a-3', cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '<command-name>/review</command-name>' }] },
    timestamp: '2026-01-01T00:01:06.000Z', uuid: 'u-4',
  }),
  JSON.stringify({
    parentUuid: 'u-4', cwd: '/tmp/project', sessionId: 'inv-session-1', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 1300, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:07.000Z', uuid: 'a-4',
  }),
].join('\n');

describe('importTranscript invocations aggregation', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('aggregates commands and skills, dedupes, preserves first-seen order', async () => {
    const filePath = join(TEST_DIR, 'invocations.jsonl');
    writeFileSync(filePath, INVOCATIONS_JSONL);

    await importTranscript(filePath);

    const session = getSession('inv-session-1');
    assert.ok(session);
    assert.ok(session.invocations, 'invocations should be set');
    const parsed = JSON.parse(session.invocations!);
    assert.deepEqual(parsed, [
      { type: 'command', name: '/review' },
      { type: 'skill', name: 'debug-pipeline' },
    ]);
  });

  it('leaves invocations null when a session has no commands or skills', async () => {
    const filePath = join(TEST_DIR, 'plain.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const session = getSession('test-session-1');
    assert.ok(session);
    assert.equal(session.invocations, null);
  });

  it('captures started_with when the first user message is a slash command', async () => {
    const filePath = join(TEST_DIR, 'started-cmd.jsonl');
    writeFileSync(filePath, INVOCATIONS_JSONL);

    await importTranscript(filePath);

    const session = getSession('inv-session-1');
    assert.ok(session);
    assert.ok(session.started_with, 'started_with should be set');
    assert.deepEqual(JSON.parse(session.started_with!), {
      type: 'command',
      name: '/review',
    });
  });

  it('skips a leading /clear and uses the first meaningful command for started_with', async () => {
    const CLEAR_FIRST_JSONL = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'clear-first-1', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'clear-first-1', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '<command-name>/review</command-name>' }] },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'u-2',
      }),
      JSON.stringify({
        parentUuid: 'u-2', cwd: '/tmp/project', sessionId: 'clear-first-1', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Reviewing.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:02.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'clear-first.jsonl');
    writeFileSync(filePath, CLEAR_FIRST_JSONL);

    await importTranscript(filePath);

    const session = getSession('clear-first-1');
    assert.ok(session);
    // started_with skips the reset command and points at /review
    assert.deepEqual(JSON.parse(session.started_with!), {
      type: 'command',
      name: '/review',
    });
    // /clear is not recorded as an invocation either
    const invocations = JSON.parse(session.invocations ?? '[]') as { type: string; name: string }[];
    assert.ok(!invocations.some((i) => i.name === '/clear'), '/clear should not be an invocation');
    assert.ok(invocations.some((i) => i.name === '/review'), '/review should be an invocation');
  });

  it('leaves started_with null when the first user message is plain text', async () => {
    const filePath = join(TEST_DIR, 'plain.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const session = getSession('test-session-1');
    assert.ok(session);
    assert.equal(session.started_with, null);
  });

  it('captures started_with as skill when first user message is a skill expansion', async () => {
    const SKILL_FIRST_JSONL = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'skill-first-1', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /home/user/.claude/skills/triage-issue\n\nTriage' }] },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'u-1',
      }),
      JSON.stringify({
        parentUuid: 'u-1', cwd: '/tmp/project', sessionId: 'skill-first-1', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Triaging.' }],
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: '2026-01-01T00:01:01.000Z', uuid: 'a-1',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'skill-first.jsonl');
    writeFileSync(filePath, SKILL_FIRST_JSONL);

    await importTranscript(filePath);

    const session = getSession('skill-first-1');
    assert.ok(session);
    assert.deepEqual(JSON.parse(session.started_with!), {
      type: 'skill',
      name: 'triage-issue',
    });
  });
});

// ── Skip / dedupe import matrix (new × changed × unchanged, parent × subagent) ──

// A parent transcript that spawns a Task subagent. sessionId === 'parent-sess'.
const PARENT_SESS_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Please investigate the bug.' },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'p-u-1',
  }),
  JSON.stringify({
    parentUuid: 'p-u-1', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'text', text: "I'll spawn an agent." },
        { type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'investigate', prompt: 'Investigate the bug', subagent_type: 'agent-aaa' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'p-a-1',
  }),
  JSON.stringify({
    parentUuid: 'p-a-1', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task-1', content: 'Found the bug.' }] },
    timestamp: '2026-01-01T00:01:20.000Z', uuid: 'p-u-2',
  }),
  JSON.stringify({
    parentUuid: 'p-u-2', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'The bug is fixed.' }],
      usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:25.000Z', uuid: 'p-a-2',
  }),
].join('\n');

// The subagent transcript. Its embedded sessionId is the PARENT's id — that's how
// the standalone branch derives the parent for an `agent-aaa.jsonl` file.
const SUBAGENT_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Investigate the bug' },
    timestamp: '2026-01-01T00:01:06.000Z', uuid: 's-u-1',
  }),
  JSON.stringify({
    parentUuid: 's-u-1', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 's-tool-1', name: 'Read', input: { file_path: '/tmp/project/bug.ts' } },
      ],
      usage: { input_tokens: 800, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:10.000Z', uuid: 's-a-1',
  }),
  JSON.stringify({
    parentUuid: 's-a-1', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's-tool-1', content: 'const x = 1;' }] },
    timestamp: '2026-01-01T00:01:11.000Z', uuid: 's-u-2',
  }),
  JSON.stringify({
    parentUuid: 's-u-2', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Found the bug.' }],
      usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:15.000Z', uuid: 's-a-2',
  }),
].join('\n');

/** Lay out a parent transcript + its subagent on disk. Returns the two paths. */
function writeParentWithSubagent(): { parentPath: string; subagentPath: string } {
  const projDir = join(TEST_DIR, 'proj');
  const parentPath = join(projDir, 'parent-sess.jsonl');
  const subagentsDir = join(projDir, 'parent-sess', 'subagents');
  const subagentPath = join(subagentsDir, 'agent-aaa.jsonl');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(parentPath, PARENT_SESS_JSONL);
  writeFileSync(subagentPath, SUBAGENT_JSONL);
  return { parentPath, subagentPath };
}

describe('importTranscript skip/dedupe matrix', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── #1: no-force re-import of an unchanged corpus writes zero event rows ──
  it('keeps event-row ids stable across a no-force re-import (no delete/reinsert)', async () => {
    const filePath = join(TEST_DIR, 'test-session-1.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);

    await importTranscript(filePath);

    const db = getDb();
    const before = db.prepare('SELECT id FROM events WHERE session_id = ? ORDER BY id').all('test-session-1');
    assert.ok(before.length > 0);

    const second = await importTranscript(filePath);
    assert.equal(second.skipped, true);
    assert.equal(second.eventCount, 0);

    const after = db.prepare('SELECT id FROM events WHERE session_id = ? ORDER BY id').all('test-session-1');
    assert.deepEqual(after, before, 'event ids must be unchanged (no delete + reinsert)');
  });

  // ── #2: filename-mismatch fallback — same embedded sessionId from a differently-named file ──
  it('recognizes an already-imported session via the post-parse fallback when the filename differs', async () => {
    const canonical = join(TEST_DIR, 'test-session-1.jsonl');
    writeFileSync(canonical, SAMPLE_JSONL);
    await importTranscript(canonical);

    const db = getDb();
    const idsBefore = db.prepare('SELECT id FROM events WHERE session_id = ? ORDER BY id').all('test-session-1');

    // Same embedded sessionId, different filename — pre-parse fast path can't fire,
    // so the post-parse sessionExists fallback must recognize it as already-imported.
    const renamed = join(TEST_DIR, 'renamed.jsonl');
    writeFileSync(renamed, SAMPLE_JSONL);
    const result = await importTranscript(renamed);

    assert.equal(result.skipped, true);
    assert.equal(result.sessionId, 'test-session-1');

    // No second session, no duplicate events.
    const sessionCount = db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number };
    assert.equal(sessionCount.n, 1, 'must not create a second session from the renamed file');
    const idsAfter = db.prepare('SELECT id FROM events WHERE session_id = ? ORDER BY id').all('test-session-1');
    assert.deepEqual(idsAfter, idsBefore);
  });

  // ── #3: standalone subagent re-import is skipped when its mtime is unchanged ──
  it('skips a standalone unchanged subagent re-import (no delete/reinsert)', async () => {
    const { parentPath, subagentPath } = writeParentWithSubagent();

    // Import the parent first — this covers the subagent.
    await importTranscript(parentPath);

    const db = getDb();
    const before = db.prepare(
      "SELECT id FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa' ORDER BY id",
    ).all();
    assert.ok(before.length > 0, 'subagent events should exist after parent import');

    // Standalone re-import of the unchanged subagent — must skip.
    const result = await importTranscript(subagentPath);
    assert.equal(result.skipped, true);
    assert.equal(result.sessionId, 'parent-sess');

    const after = db.prepare(
      "SELECT id FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa' ORDER BY id",
    ).all();
    assert.deepEqual(after, before, 'unchanged subagent must not be deleted + reinserted');
  });

  // ── #5: a changed subagent (mtime differs) is re-imported ──
  it('re-imports a standalone subagent whose mtime changed', async () => {
    const { parentPath, subagentPath } = writeParentWithSubagent();
    await importTranscript(parentPath);

    const db = getDb();
    const before = db.prepare(
      "SELECT id FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa' ORDER BY id",
    ).all();

    // Bump the subagent file's mtime forward so the stored mtime no longer matches.
    const future = new Date(Date.now() + 5000);
    utimesSync(subagentPath, future, future);

    const result = await importTranscript(subagentPath);
    assert.equal(result.skipped, false, 'a changed subagent must be re-imported');

    const after = db.prepare(
      "SELECT id FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa' ORDER BY id",
    ).all();
    assert.equal(after.length, before.length, 'event count is stable after a clean re-import');
  });

  // ── #4: filterCoveredSubagents + no-dupe batch ──
  it('filterCoveredSubagents drops a subagent whose parent is also in the batch', () => {
    const { parentPath, subagentPath } = writeParentWithSubagent();
    const filtered = filterCoveredSubagents([parentPath, subagentPath]);
    assert.deepEqual(filtered, [parentPath]);
  });

  it('keeps a subagent whose parent is NOT in the batch', () => {
    const { subagentPath } = writeParentWithSubagent();
    const filtered = filterCoveredSubagents([subagentPath]);
    assert.deepEqual(filtered, [subagentPath]);
  });

  it('importTranscripts imports each subagent exactly once (no duplicates)', async () => {
    const { parentPath, subagentPath } = writeParentWithSubagent();

    await importTranscripts([parentPath, subagentPath]);

    const db = getDb();
    const batchCount = db.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa'",
    ).get() as { n: number };

    // Compare against importing the parent alone in a fresh DB run.
    closeDb();
    rmSync(DB_PATH, { force: true });
    rmSync(`${DB_PATH}-wal`, { force: true });
    rmSync(`${DB_PATH}-shm`, { force: true });
    const db2 = getDb(DB_PATH);
    await importTranscript(parentPath);
    const soloCount = db2.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa'",
    ).get() as { n: number };

    assert.ok(batchCount.n > 0);
    assert.equal(batchCount.n, soloCount.n, 'batch import must not duplicate subagent events');
  });

  // ── #4b: a non-force batch must not strand a changed subagent whose parent is
  // already imported. The parent is skipped at the pre-parse fast path (so it does
  // NOT re-cover its subagent), so the covered-subagent drop must not fire here. ──
  it('non-force batch re-imports a changed subagent under an already-imported parent', async () => {
    const { parentPath, subagentPath } = writeParentWithSubagent();

    // First import: the parent covers the subagent.
    await importTranscript(parentPath);
    const db = getDb();
    const before = (db.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa'",
    ).get() as { n: number }).n;
    assert.ok(before > 0);

    // The subagent transcript grows by one assistant turn and its mtime bumps;
    // the parent transcript is left untouched.
    const grown = SUBAGENT_JSONL + '\n' + JSON.stringify({
      parentUuid: 's-a-2', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'And a follow-up note.' }],
        usage: { input_tokens: 950, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:18.000Z', uuid: 's-a-3',
    });
    writeFileSync(subagentPath, grown);
    const future = new Date(Date.now() + 5000);
    utimesSync(subagentPath, future, future);

    // Non-force batch over the whole corpus. filterCoveredSubagents must NOT drop
    // the subagent (the parent won't re-cover it), so the change is picked up.
    const results = await importTranscripts([parentPath, subagentPath]);
    const subResult = results.find((r) => !r.skipped && r.sessionId === 'parent-sess');
    assert.ok(subResult, 'the changed subagent must be re-imported, not dropped as covered');

    const after = (db.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = 'parent-sess' AND agent_id = 'agent-aaa'",
    ).get() as { n: number }).n;
    assert.ok(after > before, 'the grown subagent should contribute more events after re-import');
  });

  // ── #7: subagent token dedup — streamed lines sharing a message.id count once ──
  //
  // The fix (issue #98) dedups streamed assistant lines by message.id before summing
  // token totals, keeping the LAST (final cumulative) line per id. These fixtures give
  // the subagent's assistant turn multiple lines per message.id with growing cumulative
  // usage so the deduped totals are STRICTLY LESS than the naive per-line sum — that gap
  // is what makes the test guard: a revert to the naive sum would produce the larger
  // numbers and fail the assertions below.
  //
  // Deduped subagent (last line per id):  input 800 + 900 = 1700,  output 120 + 200 = 320
  // Naive per-line sum (every usage line): input 3500,             output 470
  const DEDUP_PARENT_JSONL = [
    JSON.stringify({
      parentUuid: null, cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'user',
      message: { role: 'user', content: 'Please investigate the bug.' },
      timestamp: '2026-01-01T00:01:00.000Z', uuid: 'dp-u-1',
    }),
    // Clean parent turn 1 (single line, own message.id) — spawns the subagent.
    JSON.stringify({
      parentUuid: 'dp-u-1', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'dp-msg-1', model: 'claude-opus-4-6', role: 'assistant',
        content: [
          { type: 'text', text: "I'll spawn an agent." },
          { type: 'tool_use', id: 'dp-task-1', name: 'Task', input: { description: 'investigate', prompt: 'Investigate the bug', subagent_type: 'agent-ddd' } },
        ],
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:05.000Z', uuid: 'dp-a-1',
    }),
    JSON.stringify({
      parentUuid: 'dp-a-1', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'dp-task-1', content: 'Found the bug.' }] },
      timestamp: '2026-01-01T00:01:20.000Z', uuid: 'dp-u-2',
    }),
    // Clean parent turn 2 (single line, own message.id).
    JSON.stringify({
      parentUuid: 'dp-u-2', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'dp-msg-2', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'The bug is fixed.' }],
        usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:25.000Z', uuid: 'dp-a-2',
    }),
  ].join('\n');

  // Subagent transcript whose assistant turn is STREAMED across several lines sharing
  // one message.id, with growing cumulative usage. sessionId === parent's id so the
  // standalone branch derives the parent from it.
  const DEDUP_SUBAGENT_JSONL = [
    JSON.stringify({
      parentUuid: null, cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'user',
      message: { role: 'user', content: 'Investigate the bug' },
      timestamp: '2026-01-01T00:01:06.000Z', uuid: 'ds-u-1',
    }),
    // message.id = sa-msg-1, three streamed lines with growing cumulative usage.
    JSON.stringify({
      parentUuid: 'ds-u-1', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'sa-msg-1', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'Reading' }],
        usage: { input_tokens: 500, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:07.000Z', uuid: 'ds-a-1a',
    }),
    JSON.stringify({
      parentUuid: 'ds-u-1', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'sa-msg-1', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'Reading the file' }],
        usage: { input_tokens: 600, output_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:08.000Z', uuid: 'ds-a-1b',
    }),
    JSON.stringify({
      parentUuid: 'ds-u-1', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'sa-msg-1', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'Reading the file.' }],
        usage: { input_tokens: 800, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:09.000Z', uuid: 'ds-a-1c',
    }),
    // message.id = sa-msg-2, two streamed lines with growing cumulative usage.
    JSON.stringify({
      parentUuid: 'ds-a-1c', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'sa-msg-2', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'Found' }],
        usage: { input_tokens: 700, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:14.000Z', uuid: 'ds-a-2a',
    }),
    JSON.stringify({
      parentUuid: 'ds-a-1c', cwd: '/tmp/project', sessionId: 'dedup-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'sa-msg-2', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'Found the bug.' }],
        usage: { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: '2026-01-01T00:01:15.000Z', uuid: 'ds-a-2b',
    }),
  ].join('\n');

  /** Lay out the dedup parent transcript + its streamed subagent on disk. */
  function writeDedupParentWithSubagent(): { parentPath: string; subagentPath: string; agentId: string } {
    const projDir = join(TEST_DIR, 'dedup-proj');
    const parentPath = join(projDir, 'dedup-parent.jsonl');
    const subagentsDir = join(projDir, 'dedup-parent', 'subagents');
    const agentId = 'agent-ddd';
    const subagentPath = join(subagentsDir, `${agentId}.jsonl`);
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(parentPath, DEDUP_PARENT_JSONL);
    writeFileSync(subagentPath, DEDUP_SUBAGENT_JSONL);
    return { parentPath, subagentPath, agentId };
  }

  it('counts streamed subagent assistant lines once via message.id dedup', async () => {
    const { parentPath, agentId } = writeDedupParentWithSubagent();

    await importTranscript(parentPath);

    // Deduped (last line per message.id): input 800+900, output 120+200.
    const dedupedSubagentInput = 800 + 900; // 1700
    const dedupedSubagentOutput = 120 + 200; // 320
    // Naive per-line sum over every usage-bearing assistant line.
    const naiveSubagentInput = 500 + 600 + 800 + 700 + 900; // 3500
    const naiveSubagentOutput = 30 + 70 + 120 + 50 + 200; // 470

    // Sanity: the fixture must actually exercise the dedup — deduped < naive.
    assert.ok(dedupedSubagentInput < naiveSubagentInput);
    assert.ok(dedupedSubagentOutput < naiveSubagentOutput);

    const db = getDb();
    const rel = db.prepare(
      'SELECT input_tokens_total, output_tokens_total FROM agent_relationships WHERE parent_session_id = ? AND child_agent_id = ?',
    ).get('dedup-parent', agentId) as { input_tokens_total: number; output_tokens_total: number } | undefined;
    assert.ok(rel, 'agent relationship row should exist for the subagent');

    // Behavior #1: per-id dedup, and strictly less than the naive line-sum.
    assert.equal(rel.input_tokens_total, dedupedSubagentInput);
    assert.equal(rel.output_tokens_total, dedupedSubagentOutput);
    assert.ok(rel.input_tokens_total < naiveSubagentInput, 'input must be deduped, not the naive line-sum');
    assert.ok(rel.output_tokens_total < naiveSubagentOutput, 'output must be deduped, not the naive line-sum');

    // Behavior #2: the parent total reflects the DEDUPED subagent output.
    // The parent transcript has no streamed duplicates, so its own output is a clean
    // known constant: 200 + 50.
    const parentOwnDedupedOutput = 200 + 50; // 250
    const parent = getSession('dedup-parent');
    assert.ok(parent);
    assert.equal(parent.total_output_tokens, parentOwnDedupedOutput + dedupedSubagentOutput); // 250 + 320 = 570
  });

  // ── #6: a force re-import yields the same query results as a fresh import ──
  it('force re-import produces equal results to a fresh import (modulo ids)', async () => {
    const { parentPath } = writeParentWithSubagent();

    await importTranscript(parentPath);

    const db = getDb();
    const sessionBefore = getSession('parent-sess')!;
    const eventCountBefore = (db.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = 'parent-sess'",
    ).get() as { n: number }).n;
    const agentRelBefore = db.prepare(
      "SELECT child_agent_id, prompt_data, result_data, tool_call_count, input_tokens_total, output_tokens_total FROM agent_relationships WHERE parent_session_id = 'parent-sess' ORDER BY child_agent_id",
    ).all();

    const forced = await importTranscript(parentPath, { force: true });
    assert.equal(forced.skipped, false);

    const sessionAfter = getSession('parent-sess')!;
    const eventCountAfter = (db.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = 'parent-sess'",
    ).get() as { n: number }).n;
    const agentRelAfter = db.prepare(
      "SELECT child_agent_id, prompt_data, result_data, tool_call_count, input_tokens_total, output_tokens_total FROM agent_relationships WHERE parent_session_id = 'parent-sess' ORDER BY child_agent_id",
    ).all();

    // Session fields that don't depend on autoincrement ids.
    assert.equal(sessionAfter.model, sessionBefore.model);
    assert.equal(sessionAfter.total_input_tokens, sessionBefore.total_input_tokens);
    assert.equal(sessionAfter.total_output_tokens, sessionBefore.total_output_tokens);
    assert.equal(sessionAfter.tool_call_count, sessionBefore.tool_call_count);
    assert.equal(sessionAfter.subagent_count, sessionBefore.subagent_count);
    assert.equal(sessionAfter.started_at, sessionBefore.started_at);
    assert.equal(sessionAfter.ended_at, sessionBefore.ended_at);
    assert.equal(sessionAfter.summary, sessionBefore.summary);

    assert.equal(eventCountAfter, eventCountBefore, 'event count must match a fresh import');
    assert.deepEqual(agentRelAfter, agentRelBefore, 'agent relationship data must match a fresh import');
  });
});
