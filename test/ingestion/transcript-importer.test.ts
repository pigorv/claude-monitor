import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { importTranscript, importTranscripts, filterCoveredSubagents, discoverSubagentFiles, type ImportResult } from '../../src/ingestion/transcript-importer.js';
import { getDb, closeDb } from '../../src/db/connection.js';
import { getSession, sessionExists } from '../../src/db/queries/sessions.js';
import { listEventsBySession, getTokenTimeline, getMiniTimeline } from '../../src/db/queries/events.js';
import { analyzeCompactions } from '../../src/analysis/compaction-analysis.js';

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

  it('does not enrich a row with context_pct = 0 from a synthetic zero-usage message', async () => {
    // Claude Code writes a synthetic all-zero assistant message at session end
    // whose timestamp collides with a real user message. buildEventRecords()
    // must skip it so it never stamps context_pct = 0 onto the shared-timestamp
    // row (mirroring the guard in buildTokenSnapshots).
    const SHARED_TS = '2026-01-01T00:01:10.000Z';
    const jsonl = [
      JSON.stringify({
        parentUuid: null, cwd: '/tmp/project', sessionId: 'zero-usage-sess', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Do the work.' },
        timestamp: '2026-01-01T00:01:00.000Z', uuid: 'zu-user-1',
      }),
      JSON.stringify({
        parentUuid: 'zu-user-1', cwd: '/tmp/project', sessionId: 'zero-usage-sess', version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6', role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
          usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
        },
        timestamp: '2026-01-01T00:01:05.000Z', uuid: 'zu-asst-1',
      }),
      // Real user message at the shared timestamp T.
      JSON.stringify({
        parentUuid: 'zu-asst-1', cwd: '/tmp/project', sessionId: 'zero-usage-sess', version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Anything else?' },
        timestamp: SHARED_TS, uuid: 'zu-user-2',
      }),
      // Synthetic zero-usage assistant message at the SAME timestamp T.
      JSON.stringify({
        parentUuid: 'zu-user-2', cwd: '/tmp/project', sessionId: 'zero-usage-sess', version: '2.1.0',
        type: 'assistant',
        message: {
          model: '', role: 'assistant',
          content: [],
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        timestamp: SHARED_TS, uuid: 'zu-asst-2',
      }),
    ].join('\n');

    const filePath = join(TEST_DIR, 'zero-usage-sess.jsonl');
    writeFileSync(filePath, jsonl);

    await importTranscript(filePath);

    const db = getDb();
    const rowsAtT = db.prepare(
      'SELECT context_pct FROM events WHERE session_id = ? AND timestamp = ?',
    ).all('zero-usage-sess', SHARED_TS) as { context_pct: number | null }[];

    assert.ok(rowsAtT.length > 0, 'expected at least one event row at the shared timestamp');
    for (const row of rowsAtT) {
      assert.equal(row.context_pct, null,
        'rows at T must stay unenriched (null), not stamped from the zero-usage message');
    }
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

  it('fires onProgress once per processed file with monotonic processed ending at total', async () => {
    const file1 = join(TEST_DIR, 'prog-a.jsonl');
    const file2 = join(TEST_DIR, 'prog-b.jsonl');
    const file3 = join(TEST_DIR, 'prog-c.jsonl');

    writeFileSync(file1, JSON.stringify({
      parentUuid: null, cwd: '/tmp/a', sessionId: 'prog-a', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-01T00:00:00.000Z', uuid: 'pu1',
    }));
    writeFileSync(file2, JSON.stringify({
      parentUuid: null, cwd: '/tmp/b', sessionId: 'prog-b', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-02T00:00:00.000Z', uuid: 'pu2',
    }));
    writeFileSync(file3, JSON.stringify({
      parentUuid: null, cwd: '/tmp/c', sessionId: 'prog-c', type: 'user',
      message: { role: 'user', content: 'hi' },
      timestamp: '2026-01-03T00:00:00.000Z', uuid: 'pu3',
    }));

    const files = [file1, file2, file3];
    const payloads: { processed: number; total: number; result: ImportResult }[] = [];

    const results = await importTranscripts(files, {
      onProgress: (p) => payloads.push(p),
    });

    // One callback per processed file.
    assert.equal(payloads.length, files.length);
    // processed strictly increases 1..N.
    for (let i = 0; i < payloads.length; i++) {
      assert.equal(payloads[i].processed, i + 1);
    }
    // Every payload's total equals the final processed count.
    for (const p of payloads) {
      assert.equal(p.total, files.length);
    }
    // The last payload carries the last pushed result.
    assert.deepEqual(payloads[payloads.length - 1].result, results[results.length - 1]);
  });

  it('reports onProgress total against the post-filter count under force (covered subagents dropped)', async () => {
    // The reimport route always calls with `force: true`, where
    // filterCoveredSubagents drops a subagent whose parent is in the same batch.
    // Progress must be reported against the filtered count, not the raw input.
    const { parentPath, subagentPath } = writeParentWithSubagent();

    const payloads: { processed: number; total: number; result: ImportResult }[] = [];
    const results = await importTranscripts([parentPath, subagentPath], {
      force: true,
      onProgress: (p) => payloads.push(p),
    });

    // The subagent is covered by the parent, so only one file is processed.
    assert.equal(results.length, 1);
    assert.equal(payloads.length, 1);
    // total reflects the post-filter count (1), not the 2 input paths.
    assert.equal(payloads[0].total, 1);
    assert.equal(payloads[0].processed, 1);
    // processed lands exactly on total — no off-by-one against the unfiltered input.
    assert.equal(payloads[payloads.length - 1].processed, payloads[payloads.length - 1].total);
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
    const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'happy', 'sample-session.jsonl');

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

// A second subagent transcript under the same parent session. Used to prove the
// sequence_num offset stacks across MULTIPLE subagent streams sharing one
// session_id — not just parent↔subagent — since the offset query is session-wide.
const SUBAGENT_BBB_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Write the fix' },
    timestamp: '2026-01-01T00:01:16.000Z', uuid: 'b-u-1',
  }),
  JSON.stringify({
    parentUuid: 'b-u-1', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'text', text: 'Editing the file.' },
        { type: 'tool_use', id: 'b-tool-1', name: 'Edit', input: { file_path: '/tmp/project/bug.ts' } },
      ],
      usage: { input_tokens: 700, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:17.000Z', uuid: 'b-a-1',
  }),
  JSON.stringify({
    parentUuid: 'b-a-1', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b-tool-1', content: 'ok' }] },
    timestamp: '2026-01-01T00:01:18.000Z', uuid: 'b-u-2',
  }),
  JSON.stringify({
    parentUuid: 'b-u-2', cwd: '/tmp/project', sessionId: 'parent-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Fix written.' }],
      usage: { input_tokens: 750, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:19.000Z', uuid: 'b-a-2',
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

/** Lay out a parent + two subagent streams (agent-aaa, agent-bbb) on disk. */
function writeParentWithTwoSubagents(): { parentPath: string } {
  const projDir = join(TEST_DIR, 'proj');
  const parentPath = join(projDir, 'parent-sess.jsonl');
  const subagentsDir = join(projDir, 'parent-sess', 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(parentPath, PARENT_SESS_JSONL);
  writeFileSync(join(subagentsDir, 'agent-aaa.jsonl'), SUBAGENT_JSONL);
  writeFileSync(join(subagentsDir, 'agent-bbb.jsonl'), SUBAGENT_BBB_JSONL);
  return { parentPath };
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

  // ── T1.1: subagent sequence_num is offset into a collision-free per-session order ──
  it('offsets subagent sequence_num above the parent stream (no collisions across re-imports)', async () => {
    const { parentPath } = writeParentWithSubagent();

    // Importing the parent also imports the subagent under the same session_id.
    await importTranscript(parentPath);

    const db = getDb();
    const dupQuery = db.prepare(
      'SELECT sequence_num, COUNT(*) AS n FROM events WHERE session_id = ? GROUP BY sequence_num HAVING COUNT(*) > 1',
    );

    // Behavior #1: sequence_num is collision-free across the whole session.
    assert.deepEqual(dupQuery.all('parent-sess'), [], 'no colliding sequence_num within the session');

    // Behavior #2: every subagent row sits strictly above the parent stream's max.
    // The subagent's events are tagged with the file-derived id 'agent-aaa';
    // the parent stream is every other row (some parent rows carry their own
    // spawn agent_id, so IS NULL alone doesn't isolate the parent stream).
    const parentMax = db.prepare(
      "SELECT MAX(sequence_num) AS m FROM events WHERE session_id = ? AND (agent_id IS NULL OR agent_id != 'agent-aaa')",
    );
    const subMin = db.prepare(
      "SELECT MIN(sequence_num) AS m FROM events WHERE session_id = ? AND agent_id = 'agent-aaa'",
    );
    const maxParent = (parentMax.get('parent-sess') as { m: number }).m;
    const minSub = (subMin.get('parent-sess') as { m: number | null }).m;
    assert.ok(minSub !== null, 'subagent rows should exist after parent import');
    assert.ok(minSub > maxParent, 'every subagent sequence_num must exceed the parent stream max');

    // Collision-freeness and ordering hold after a --force full re-import.
    await importTranscript(parentPath, { force: true });
    assert.deepEqual(dupQuery.all('parent-sess'), [], 'no duplicates after a --force re-import');

    const minSubAfter = (subMin.get('parent-sess') as { m: number | null }).m;
    const maxParentAfter = (parentMax.get('parent-sess') as { m: number }).m;
    assert.ok(minSubAfter !== null && minSubAfter > maxParentAfter, 'ordering holds after --force');
  });

  // ── T1.2: TWO subagent streams under one session stack without colliding ──
  // The offset query is session-wide (MAX(sequence_num) over the whole session),
  // so agent-bbb must land above agent-aaa, not restart at the parent max. A
  // regression scoping the offset per-agent-stream would reintroduce
  // subagent↔subagent collisions that the single-subagent T1.1 can't catch.
  it('stacks multiple subagent streams above one another (no cross-subagent collisions)', async () => {
    const { parentPath } = writeParentWithTwoSubagents();
    await importTranscript(parentPath);

    const db = getDb();

    // Whole-session sequence_num stays collision-free across parent + both subagents.
    const dups = db.prepare(
      'SELECT sequence_num, COUNT(*) AS n FROM events WHERE session_id = ? GROUP BY sequence_num HAVING COUNT(*) > 1',
    ).all('parent-sess');
    assert.deepEqual(dups, [], 'no colliding sequence_num across parent + two subagents');

    // Both subagent streams were imported (discoverSubagentFiles sorts, so aaa first).
    const seqRange = (agentId: string) => db.prepare(
      'SELECT MIN(sequence_num) AS lo, MAX(sequence_num) AS hi FROM events WHERE session_id = ? AND agent_id = ?',
    ).get('parent-sess', agentId) as { lo: number | null; hi: number | null };
    const aaa = seqRange('agent-aaa');
    const bbb = seqRange('agent-bbb');
    assert.ok(aaa.lo !== null && bbb.lo !== null, 'both subagent streams should have rows');

    // agent-bbb sits strictly above agent-aaa — the second stream offsets past the
    // first, not back onto the parent max (which is what a per-agent-scoped offset
    // regression would do, colliding bbb with aaa).
    assert.ok(bbb.lo! > aaa.hi!, 'agent-bbb must offset above agent-aaa, not collide with it');
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
    // child_agent_id is derived from the subagent filename (basename minus .jsonl),
    // NOT from the parent Task's subagent_type — keep them aligned only for readability.
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

  // ── T3.1: cache-write split persists on the session + sub-agent cache sums ──
  //
  // The parent's assistant turns carry a cache_creation breakdown (5m + 1h) plus
  // a flat grand total, so the session aggregate has a non-trivial 5m/1h split.
  // The sub-agent also carries cache tokens so agent_relationships records the
  // summed-over-deduped-assistant-messages cache_*_total columns.
  const CACHE_PARENT_JSONL = [
    JSON.stringify({
      parentUuid: null, cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'user',
      message: { role: 'user', content: 'Please investigate the bug.' },
      timestamp: '2026-01-01T00:01:00.000Z', uuid: 'cp-u-1',
    }),
    JSON.stringify({
      parentUuid: 'cp-u-1', cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'cp-msg-1', model: 'claude-opus-4-6', role: 'assistant',
        content: [
          { type: 'text', text: "I'll spawn an agent." },
          { type: 'tool_use', id: 'cp-task-1', name: 'Task', input: { description: 'investigate', prompt: 'Investigate the bug', subagent_type: 'agent-ccc' } },
        ],
        usage: {
          input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 400,
          cache_creation_input_tokens: 300,
          cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 },
        },
      },
      timestamp: '2026-01-01T00:01:05.000Z', uuid: 'cp-a-1',
    }),
    JSON.stringify({
      parentUuid: 'cp-a-1', cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cp-task-1', content: 'Found the bug.' }] },
      timestamp: '2026-01-01T00:01:20.000Z', uuid: 'cp-u-2',
    }),
    JSON.stringify({
      parentUuid: 'cp-u-2', cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'cp-msg-2', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'The bug is fixed.' }],
        usage: {
          input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 600,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 350, ephemeral_1h_input_tokens: 150 },
        },
      },
      timestamp: '2026-01-01T00:01:25.000Z', uuid: 'cp-a-2',
    }),
  ].join('\n');

  // Sub-agent transcript whose assistant turns carry cache tokens. sessionId is
  // the parent's id so the standalone branch derives the parent from it.
  const CACHE_SUBAGENT_JSONL = [
    JSON.stringify({
      parentUuid: null, cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'user',
      message: { role: 'user', content: 'Investigate the bug' },
      timestamp: '2026-01-01T00:01:06.000Z', uuid: 'cs-u-1',
    }),
    JSON.stringify({
      parentUuid: 'cs-u-1', cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'cs-msg-1', model: 'claude-opus-4-6', role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', id: 'cs-tool-1', name: 'Read', input: { file_path: '/tmp/project/bug.ts' } },
        ],
        usage: {
          input_tokens: 800, output_tokens: 100, cache_read_input_tokens: 250,
          cache_creation_input_tokens: 120,
          cache_creation: { ephemeral_5m_input_tokens: 80, ephemeral_1h_input_tokens: 40 },
        },
      },
      timestamp: '2026-01-01T00:01:10.000Z', uuid: 'cs-a-1',
    }),
    JSON.stringify({
      parentUuid: 'cs-a-1', cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cs-tool-1', content: 'const x = 1;' }] },
      timestamp: '2026-01-01T00:01:11.000Z', uuid: 'cs-u-2',
    }),
    JSON.stringify({
      parentUuid: 'cs-u-2', cwd: '/tmp/project', sessionId: 'cache-parent', version: '2.1.0',
      type: 'assistant',
      message: {
        id: 'cs-msg-2', model: 'claude-opus-4-6', role: 'assistant',
        content: [{ type: 'text', text: 'Found the bug.' }],
        usage: {
          input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 350,
          cache_creation_input_tokens: 90,
          cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 30 },
        },
      },
      timestamp: '2026-01-01T00:01:15.000Z', uuid: 'cs-a-2',
    }),
  ].join('\n');

  function writeCacheParentWithSubagent(): { parentPath: string; agentId: string } {
    const projDir = join(TEST_DIR, 'cache-proj');
    const parentPath = join(projDir, 'cache-parent.jsonl');
    const subagentsDir = join(projDir, 'cache-parent', 'subagents');
    const agentId = 'agent-ccc';
    const subagentPath = join(subagentsDir, `${agentId}.jsonl`);
    mkdirSync(subagentsDir, { recursive: true });
    writeFileSync(parentPath, CACHE_PARENT_JSONL);
    writeFileSync(subagentPath, CACHE_SUBAGENT_JSONL);
    return { parentPath, agentId };
  }

  it('persists the cache-write split on the session and sub-agent cache sums', async () => {
    const { parentPath, agentId } = writeCacheParentWithSubagent();

    // Import once, then force-reimport to exercise the upsert path too.
    await importTranscript(parentPath);
    const forced = await importTranscript(parentPath, { force: true });
    assert.equal(forced.skipped, false);

    // Behavior #4: session split columns carry the exact aggregate, with 5m + 1h
    // <= total cache write. Pin the values so a swap or zeroing in
    // buildSessionRecord is caught (parent input 1000+1500; 5m 200+350; 1h 100+150).
    const session = getSession('cache-parent');
    assert.ok(session);
    assert.equal(session.total_input_tokens_billed, 2500);
    assert.equal(session.total_cache_write_5m_tokens, 550);
    assert.equal(session.total_cache_write_1h_tokens, 250);
    assert.ok(
      session.total_cache_write_5m_tokens! + session.total_cache_write_1h_tokens! <=
        session.total_cache_write_tokens!,
      '5m + 1h must not exceed the combined cache-write total',
    );

    // Behavior #5: agent_relationships cache *_total columns summed + non-null.
    // Deduped sub-agent assistant turns: cache_read 250+350, 5m 80+60, 1h 40+30.
    const db = getDb();
    const rel = db.prepare(
      'SELECT cache_read_total, cache_write_5m_total, cache_write_1h_total FROM agent_relationships WHERE parent_session_id = ? AND child_agent_id = ?',
    ).get('cache-parent', agentId) as
      | { cache_read_total: number | null; cache_write_5m_total: number | null; cache_write_1h_total: number | null }
      | undefined;
    assert.ok(rel, 'agent relationship row should exist for the sub-agent');
    assert.notEqual(rel.cache_read_total, null);
    assert.notEqual(rel.cache_write_5m_total, null);
    assert.notEqual(rel.cache_write_1h_total, null);
    assert.equal(rel.cache_read_total, 250 + 350);
    assert.equal(rel.cache_write_5m_total, 80 + 60);
    assert.equal(rel.cache_write_1h_total, 40 + 30);
  });
});

// A parent transcript that spawns two Agents: the first fails instantly (the
// tool_result carries `is_error: true` and no `agentId`, e.g. an unknown
// `subagent_type`), the second completes normally. sessionId === 'fail-sess'.
const FAILED_SPAWN_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'fail-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Spawn two agents.' },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'f-u-1',
  }),
  JSON.stringify({
    parentUuid: 'f-u-1', cwd: '/tmp/project', sessionId: 'fail-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'text', text: 'Spawning the first agent.' },
        { type: 'tool_use', id: 'agent-fail', name: 'Agent', input: { description: 'broken', prompt: 'do work', subagent_type: 'Nonexistent' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'f-a-1',
  }),
  JSON.stringify({
    parentUuid: 'f-a-1', cwd: '/tmp/project', sessionId: 'fail-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-fail', is_error: true, content: "Agent type 'Nonexistent' not found" }] },
    timestamp: '2026-01-01T00:01:06.000Z', uuid: 'f-u-2',
  }),
  JSON.stringify({
    parentUuid: 'f-u-2', cwd: '/tmp/project', sessionId: 'fail-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'text', text: 'Spawning the second agent.' },
        { type: 'tool_use', id: 'agent-ok', name: 'Agent', input: { description: 'works', prompt: 'do work', subagent_type: 'Explore' } },
      ],
      usage: { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:10.000Z', uuid: 'f-a-2',
  }),
  JSON.stringify({
    parentUuid: 'f-a-2', cwd: '/tmp/project', sessionId: 'fail-sess', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agent-ok', content: 'Done.' }] },
    timestamp: '2026-01-01T00:01:20.000Z', uuid: 'f-u-3',
  }),
  JSON.stringify({
    parentUuid: 'f-u-3', cwd: '/tmp/project', sessionId: 'fail-sess', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Both done.' }],
      usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:25.000Z', uuid: 'f-a-3',
  }),
].join('\n');

describe('importTranscript failed agent spawns', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('records a failed spawn as status=failed and excludes it from subagent_count', async () => {
    const filePath = join(TEST_DIR, 'fail-sess.jsonl');
    writeFileSync(filePath, FAILED_SPAWN_JSONL);

    await importTranscript(filePath);

    // The failed spawn must not inflate the session's subagent count.
    const session = getSession('fail-sess');
    assert.ok(session);
    assert.equal(session.subagent_count, 1);

    // Both agents get a row, but only the failed one is marked 'failed'.
    const rows = getDb()
      .prepare('SELECT status FROM agent_relationships WHERE parent_session_id = ?')
      .all('fail-sess') as Array<{ status: string }>;
    assert.equal(rows.length, 2);
    const statuses = rows.map((r) => r.status).sort();
    assert.deepEqual(statuses, ['completed', 'failed']);
  });
});

// ── Subagent efficiency metric population (regression for issue #93 / dd96be9) ──

// A parent whose Task tool_result carries an `agentId` matching the on-disk
// subagent file (agent-lnk.jsonl). This mirrors what real Claude Code transcripts
// do, producing exactly ONE linked agent_relationships row — unlike
// writeParentWithSubagent(), which omits agentId and yields two unlinked rows.
const PARENT_LINKED_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Please investigate the bug.' },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'pl-u-1',
  }),
  JSON.stringify({
    parentUuid: 'pl-u-1', cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'text', text: "I'll spawn an agent." },
        { type: 'tool_use', id: 'task-lnk', name: 'Task', input: { description: 'investigate', prompt: 'Investigate the bug', subagent_type: 'general-purpose' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'pl-a-1',
  }),
  // tool_result carries the real subagent id as a sibling `agentId` field.
  JSON.stringify({
    parentUuid: 'pl-a-1', cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'task-lnk', content: 'Found the bug.', agentId: 'lnk' }] },
    timestamp: '2026-01-01T00:01:20.000Z', uuid: 'pl-u-2',
  }),
  JSON.stringify({
    parentUuid: 'pl-u-2', cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'The bug is fixed.' }],
      usage: { input_tokens: 1500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:25.000Z', uuid: 'pl-a-2',
  }),
].join('\n');

// The subagent transcript (agent-lnk.jsonl). Two assistant messages carry usage
// with all cache fields 0; effective context peak === max(input) === 900.
const SUBAGENT_LINKED_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: 'Investigate the bug' },
    timestamp: '2026-01-01T00:01:06.000Z', uuid: 'sl-u-1',
  }),
  JSON.stringify({
    parentUuid: 'sl-u-1', cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'sl-tool-1', name: 'Read', input: { file_path: '/tmp/project/bug.ts' } },
      ],
      usage: { input_tokens: 800, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:10.000Z', uuid: 'sl-a-1',
  }),
  JSON.stringify({
    parentUuid: 'sl-a-1', cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sl-tool-1', content: 'const x = 1;' }] },
    timestamp: '2026-01-01T00:01:11.000Z', uuid: 'sl-u-2',
  }),
  JSON.stringify({
    parentUuid: 'sl-u-2', cwd: '/tmp/project', sessionId: 'parent-linked', version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Found the bug.' }],
      usage: { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:15.000Z', uuid: 'sl-a-2',
  }),
].join('\n');

/** Lay out the linked parent + its subagent on disk. Returns the parent path. */
function writeLinkedParentWithSubagent(): { parentPath: string } {
  const projDir = join(TEST_DIR, 'proj-linked');
  const parentPath = join(projDir, 'parent-linked.jsonl');
  const subagentsDir = join(projDir, 'parent-linked', 'subagents');
  const subagentPath = join(subagentsDir, 'agent-lnk.jsonl');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(parentPath, PARENT_LINKED_JSONL);
  writeFileSync(subagentPath, SUBAGENT_LINKED_JSONL);
  return { parentPath };
}

describe('importTranscript subagent efficiency', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // Regression: the per-agent efficiency pass must run AFTER subagent transcripts
  // are imported, populating peak_context_tokens / compression_ratio /
  // agent_compaction_count on the single linked row. Before the fix these were NULL.
  it('populates efficiency columns on the linked subagent row after parent import', async () => {
    const { parentPath } = writeLinkedParentWithSubagent();

    await importTranscript(parentPath);

    const db = getDb();

    // Lock in the linkage: exactly one row for the file-backed agent id.
    const count = db.prepare(
      'SELECT count(*) AS n FROM agent_relationships WHERE child_agent_id = ?',
    ).get('agent-lnk') as { n: number };
    assert.equal(count.n, 1, 'expected exactly one linked agent_relationships row');

    const row = db.prepare(
      'SELECT peak_context_tokens, compression_ratio, agent_compaction_count FROM agent_relationships WHERE parent_session_id = ? AND child_agent_id = ?',
    ).get('parent-linked', 'agent-lnk') as {
      peak_context_tokens: number | null;
      compression_ratio: number | null;
      agent_compaction_count: number | null;
    };
    assert.ok(row, 'linked agent row must exist');

    // Effective context peak === max input across the two timeline points (cache 0).
    assert.equal(row.peak_context_tokens, 900);
    // compression_ratio is derived from the effective peak — non-null and positive.
    assert.notEqual(row.compression_ratio, null);
    assert.ok((row.compression_ratio as number) > 0, 'compression_ratio must be > 0');
    // agent_compaction_count is populated (0 here, but must NOT be NULL).
    assert.notEqual(row.agent_compaction_count, null);
  });
});

// ── Compaction event emission (T1.1) ───────────────────────────────

describe('importTranscript — compaction events', () => {
  const FIXTURE = join(process.cwd(), 'test/fixtures/compaction/compaction-session.jsonl');
  const SESSION_ID = '064b1fea-7fc0-4545-a0f7-30926b99f02d';

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('emits compaction events matching sessions.compaction_count, with token parity and no agent_id', async () => {
    await importTranscript(FIXTURE, { force: true });

    const session = getSession(SESSION_ID);
    assert.ok(session, 'session must exist');

    const db = getDb();

    // AC #1: ≥1 compaction row, count === sessions.compaction_count.
    const compactionRows = db.prepare(
      "SELECT * FROM events WHERE session_id = ? AND event_type = 'compaction'",
    ).all(SESSION_ID) as Array<{
      timestamp: string;
      sequence_num: number;
      input_tokens: number | null;
      output_tokens: number | null;
      cache_read_tokens: number | null;
      cache_write_tokens: number | null;
      agent_id: string | null;
    }>;
    assert.ok(compactionRows.length >= 1, 'expected at least one compaction event');
    assert.equal(compactionRows.length, session.compaction_count, 'compaction rows must equal sessions.compaction_count');

    // AC #3: no compaction row carries an agent_id (parent-only).
    for (const row of compactionRows) {
      assert.equal(row.agent_id, null, 'compaction rows must have NULL agent_id');
    }

    // AC #2: the re-typed row keeps the compacted turn's exact per-column
    // usage — the fixture's compacted turn is msg_01Swb3A6rhNnmdinQZQnWCNg
    // (input 5999 / cache_read 16373 / cache_write 13144 / output 894).
    assert.equal(compactionRows.length, 1);
    const compactionRow = compactionRows[0];
    assert.equal(compactionRow.input_tokens, 5999);
    assert.equal(compactionRow.cache_read_tokens, 16373);
    assert.equal(compactionRow.cache_write_tokens, 13144);
    assert.equal(compactionRow.output_tokens, 894);

    // The importer persists the pre-drop context in metadata — the previous
    // turn (msg_01ALCNf7a1aiBUY9XLADciZN) peaked at effective 160452.
    const rowWithMeta = db.prepare(
      "SELECT metadata FROM events WHERE session_id = ? AND event_type = 'compaction'",
    ).get(SESSION_ID) as { metadata: string | null };
    assert.ok(rowWithMeta.metadata, 'compaction row must carry metadata');
    const meta = JSON.parse(rowWithMeta.metadata!);
    assert.equal(meta.compaction.tokens_before, 160452);
    assert.equal(typeof meta.compaction.context_pct_before, 'number');

    // End-to-end regression for the same-turn-sibling hazard: the compacted
    // turn's own thinking row carries identical post-drop usage, so a naive
    // backward scan would report before == after (0 tokens lost). The
    // metadata-persisted pre-drop peak must win.
    const details = analyzeCompactions(SESSION_ID);
    assert.equal(details.length, 1);
    assert.equal(details[0].tokens_before, 160452);
    assert.equal(details[0].tokens_after, 35516);
    assert.ok(details[0].tokens_before > details[0].tokens_after, 'tokens lost must be positive');
    // At least one assistant_message survives (only compacted turns re-typed).
    const asstCount = db.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = ? AND event_type = 'assistant_message' AND agent_id IS NULL",
    ).get(SESSION_ID) as { n: number };
    assert.ok(asstCount.n > 0, 'non-compacted turns must remain assistant_message');

    // AC #4: timeline queries surface the compaction point. getMiniTimeline
    // coerces to a real boolean; getTokenTimeline carries SQLite's 0/1, so
    // assert truthiness rather than strict identity there.
    const timeline = getTokenTimeline(SESSION_ID);
    assert.ok(timeline.some((p) => Boolean(p.is_compaction)), 'getTokenTimeline must flag a compaction point');

    const mini = getMiniTimeline(SESSION_ID);
    assert.ok(mini.some((p) => p.is_compaction === true), 'getMiniTimeline must preserve a compaction point');
  });

  it('synthesizes a compaction event when the compacted turn has no text block', async () => {
    // A tool-only turn emits tool_call_start but NO assistant_message, so the
    // re-type join has nothing to match — the importer must synthesize the
    // compaction row so markers and event-derived counts still line up with
    // sessions.compaction_count.
    const toolOnlySessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const line = (obj: Record<string, unknown>) => JSON.stringify(obj);
    const usage = (input: number, output: number) => ({
      input_tokens: input, output_tokens: output,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    });
    const jsonl = [
      line({ type: 'user', uuid: 'u-1', parentUuid: null, timestamp: '2026-01-01T10:00:00.000Z', sessionId: toolOnlySessionId, message: { role: 'user', content: 'first prompt' } }),
      line({ type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', timestamp: '2026-01-01T10:00:10.000Z', sessionId: toolOnlySessionId, message: { id: 'msg_text', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'building context' }], usage: usage(100000, 50) } }),
      line({ type: 'user', uuid: 'u-2', parentUuid: 'a-1', timestamp: '2026-01-01T10:01:00.000Z', sessionId: toolOnlySessionId, message: { role: 'user', content: 'continue' } }),
      // Compacted turn (100000 → 30000, a 70% drop) that is tool_use-only.
      line({ type: 'assistant', uuid: 'a-2', parentUuid: 'u-2', timestamp: '2026-01-01T10:02:00.000Z', sessionId: toolOnlySessionId, message: { id: 'msg_tool', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/x' } }], usage: usage(30000, 20) } }),
    ].join('\n');
    const fixturePath = join(TEST_DIR, 'tool-only-compaction.jsonl');
    writeFileSync(fixturePath, jsonl);

    await importTranscript(fixturePath, { force: true });

    const session = getSession(toolOnlySessionId);
    assert.ok(session, 'session must exist');
    assert.equal(session.compaction_count, 1);

    const db = getDb();
    const rows = db.prepare(
      "SELECT timestamp, agent_id, input_tokens, metadata, sequence_num FROM events WHERE session_id = ? AND event_type = 'compaction'",
    ).all(toolOnlySessionId) as Array<{ timestamp: string; agent_id: string | null; input_tokens: number | null; metadata: string | null; sequence_num: number }>;
    assert.equal(rows.length, 1, 'tool-only compacted turn must still produce a compaction event');
    assert.equal(rows[0].agent_id, null);
    assert.equal(rows[0].timestamp, '2026-01-01T10:02:00.000Z');
    assert.equal(rows[0].input_tokens, 30000);
    const meta = JSON.parse(rows[0].metadata!);
    assert.equal(meta.compaction.tokens_before, 100000);
    assert.equal(meta.compaction.synthetic, true);

    // The synthetic row is spliced in timestamp order, not appended: the
    // turn's own tool_call_start at the same timestamp must not precede it
    // by a full session (i.e. sequence numbers stay strictly increasing and
    // unique across the session).
    const seqs = db.prepare(
      'SELECT sequence_num FROM events WHERE session_id = ? ORDER BY sequence_num',
    ).all(toolOnlySessionId) as Array<{ sequence_num: number }>;
    const values = seqs.map((s) => s.sequence_num);
    assert.equal(new Set(values).size, values.length, 'sequence numbers must be unique');
  });
});

// ── T1.1: recursive subagent discovery + nested parent-path resolution ──

const NESTED_PARENT_JSONL = PARENT_SESS_JSONL.replace(/parent-sess/g, 'nested-parent');
const NESTED_SUBAGENT_JSONL = SUBAGENT_JSONL.replace(/parent-sess/g, 'nested-parent');

/**
 * Lay out a parent transcript + a nested Workflow subagent on disk:
 *   {proj}/nested-parent.jsonl
 *   {proj}/nested-parent/subagents/workflows/<runId>/agent-nested.jsonl
 */
function writeParentWithNestedSubagent(): { parentPath: string; nestedPath: string } {
  const projDir = join(TEST_DIR, 'nproj');
  const parentPath = join(projDir, 'nested-parent.jsonl');
  const nestedDir = join(projDir, 'nested-parent', 'subagents', 'workflows', 'wf-run-01');
  const nestedPath = join(nestedDir, 'agent-nested.jsonl');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(parentPath, NESTED_PARENT_JSONL);
  writeFileSync(nestedPath, NESTED_SUBAGENT_JSONL);
  return { parentPath, nestedPath };
}

describe('discoverSubagentFiles recursion + nested parent resolution (T1.1)', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Behavior #1: nested subagents/workflows/<runId>/agent-*.jsonl are discovered ──
  it('discovers a nested Workflow subagent under subagents/workflows/<runId>/', () => {
    const { parentPath, nestedPath } = writeParentWithNestedSubagent();
    const discovered = discoverSubagentFiles(parentPath);
    assert.deepEqual(discovered, [resolve(nestedPath)]);
  });

  // ── Behavior #1: flat + nested files are all returned, absolute + sorted ──
  it('returns both flat and nested subagent files, absolute and sorted', () => {
    const { parentPath } = writeParentWithNestedSubagent();
    const projDir = join(TEST_DIR, 'nproj');
    // Add a flat sibling next to the nested one under the same subagents/ root.
    const flatPath = join(projDir, 'nested-parent', 'subagents', 'agent-flat.jsonl');
    writeFileSync(flatPath, NESTED_SUBAGENT_JSONL);

    const nestedPath = join(projDir, 'nested-parent', 'subagents', 'workflows', 'wf-run-01', 'agent-nested.jsonl');
    const discovered = discoverSubagentFiles(parentPath);

    const expected = [resolve(flatPath), resolve(nestedPath)].sort();
    assert.deepEqual(discovered, expected);
    // Every path is absolute.
    for (const p of discovered) {
      assert.equal(p, resolve(p), 'discovered paths must be absolute');
    }
  });

  // ── Behavior #7: flat-only discovery is byte-identical to before ──
  it('flat-only discovery returns exactly the immediate subagents/*.jsonl child', () => {
    const { parentPath, subagentPath } = writeParentWithSubagent();
    const discovered = discoverSubagentFiles(parentPath);
    assert.deepEqual(discovered, [resolve(subagentPath)]);
  });

  it('returns [] when there is no subagents directory', () => {
    const filePath = join(TEST_DIR, 'lonely.jsonl');
    writeFileSync(filePath, SAMPLE_JSONL);
    assert.deepEqual(discoverSubagentFiles(filePath), []);
  });

  // ── Behavior #5: filterCoveredSubagents drops a nested subagent whose parent is in the batch ──
  it('filterCoveredSubagents drops a NESTED subagent whose parent is in the batch', () => {
    const { parentPath, nestedPath } = writeParentWithNestedSubagent();
    const filtered = filterCoveredSubagents([parentPath, nestedPath]);
    assert.deepEqual(filtered, [parentPath]);
  });

  // ── Behavior #5: a nested subagent whose parent is NOT in the batch is kept ──
  it('filterCoveredSubagents keeps a NESTED subagent whose parent is NOT in the batch', () => {
    const { nestedPath } = writeParentWithNestedSubagent();
    const filtered = filterCoveredSubagents([nestedPath]);
    assert.deepEqual(filtered, [nestedPath]);
  });

  // ── Behavior #1 + #4: exercised end-to-end against the on-disk fixture ──
  it('imports the nested-workflow fixture, covering the nested subagent from the parent', async () => {
    const fixturePath = join(import.meta.dirname, '..', 'fixtures', 'subagent', 'nested-workflow-parent.jsonl');

    // Discovery finds the nested fixture agent file.
    const discovered = discoverSubagentFiles(fixturePath);
    assert.equal(discovered.length, 1, 'the fixture has exactly one nested subagent');
    assert.ok(discovered[0].endsWith('agent-abc123def456789.jsonl'));

    const result = await importTranscript(fixturePath);
    assert.equal(result.sessionId, 'nested-workflow-parent');
    assert.equal(result.skipped, false);

    const db = getDb();
    const subRows = db.prepare(
      "SELECT count(*) AS n FROM events WHERE session_id = 'nested-workflow-parent' AND agent_id = 'agent-abc123def456789'",
    ).get() as { n: number };
    assert.ok(subRows.n > 0, 'the nested subagent stream must be imported under the parent session');
  });
});
