import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb, insertSession, insertEvent } from '../../../src/db/index.js';
import { listSessions } from '../../../src/db/queries/sessions.js';
import { getMessageMatchesForSessions } from '../../../src/db/queries/events.js';
import { buildFtsMatch } from '../../../src/db/queries/fts-match.js';
import { SNIPPET_MARK_START, SNIPPET_MARK_END } from '../../../src/shared/search.js';
import type { Session, Event } from '../../../src/shared/types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    project_path: '/tmp/test',
    project_name: 'test',
    model: 'claude-sonnet-4-20250514',
    models_used: null,
    source: 'startup',
    status: 'completed',
    started_at: '2025-01-01T00:00:00.000Z',
    ended_at: '2025-01-01T01:00:00.000Z',
    duration_ms: 3600000,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_input_tokens_billed: 0,
    total_cache_write_5m_tokens: 0,
    total_cache_write_1h_tokens: 0,
    peak_context_pct: 0,
    compaction_count: 0,
    tool_call_count: 0,
    subagent_count: 0,
    summary: null,
    end_reason: null,
    transcript_path: '/tmp/t.jsonl',
    metadata: null,
    invocations: null,
    started_with: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Omit<Event, 'id'>> = {}): Omit<Event, 'id'> {
  return {
    session_id: 'sess-1',
    agent_id: null,
    event_type: 'user_message',
    event_source: 'transcript_import',
    tool_name: null,
    timestamp: '2025-01-01T00:05:00.000Z',
    sequence_num: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    context_pct: 0,
    input_preview: null,
    input_data: null,
    output_preview: null,
    output_data: null,
    thinking_summary: null,
    thinking_text: null,
    duration_ms: null,
    metadata: null,
    ...overrides,
  };
}

describe('buildFtsMatch', () => {
  it('ANDs multiple words with the last as a prefix', () => {
    assert.equal(buildFtsMatch('git worktree'), '"git" "worktree"*');
  });

  it('prefixes a single word for search-as-you-type', () => {
    assert.equal(buildFtsMatch('workt'), '"workt"*');
  });

  it('does not prefix a last word shorter than the floor (avoids a runaway 1-char scan)', () => {
    // A 1-char last token stays an exact term, never `"a"*`.
    assert.equal(buildFtsMatch('a'), '"a"');
    // Multi-word: only the last word is gated; earlier words are exact anyway.
    assert.equal(buildFtsMatch('worktree a'), '"worktree" "a"');
    // The floor counts alphanumerics, not raw length — punctuation doesn't pad it.
    assert.equal(buildFtsMatch('a.'), '"a."');
    // Two alphanumerics is enough to expand.
    assert.equal(buildFtsMatch('ab'), '"ab"*');
  });

  it('escapes embedded double quotes so input is matched literally', () => {
    assert.equal(buildFtsMatch('foo"bar'), '"foo""bar"*');
  });

  it('drops non-word tokens but keeps real words', () => {
    assert.equal(buildFtsMatch('git -- worktree'), '"git" "worktree"*');
  });

  it('returns null for empty / whitespace / punctuation-only input', () => {
    assert.equal(buildFtsMatch(''), null);
    assert.equal(buildFtsMatch('   '), null);
    assert.equal(buildFtsMatch('!!!'), null);
    assert.equal(buildFtsMatch('() => {}'), null);
  });
});

describe('listSessions message-content search', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fts-search-test-'));
    getDb(join(tmpDir, 'test.sqlite'));

    // A: hit in the FIRST user message → tier 1
    insertSession(makeSession({ id: 'a', summary: 'Session A', project_name: 'proja', started_at: '2025-01-05T00:00:00.000Z' }));
    insertEvent(makeEvent({ session_id: 'a', event_type: 'user_message', sequence_num: 1, input_data: 'first message about worktree setup' }));

    // B: first user message does NOT match; a LATER user message does → tier 2
    insertSession(makeSession({ id: 'b', summary: 'Session B', project_name: 'projb', started_at: '2025-01-03T00:00:00.000Z' }));
    insertEvent(makeEvent({ session_id: 'b', event_type: 'user_message', sequence_num: 1, input_data: 'hello there' }));
    insertEvent(makeEvent({ session_id: 'b', event_type: 'user_message', sequence_num: 2, input_data: 'later I mention worktree again' }));

    // C: only an assistant message matches → tier 3
    insertSession(makeSession({ id: 'c', summary: 'Session C', project_name: 'projc', started_at: '2025-01-02T00:00:00.000Z' }));
    insertEvent(makeEvent({ session_id: 'c', event_type: 'user_message', sequence_num: 1, input_data: 'nothing relevant here' }));
    insertEvent(makeEvent({ session_id: 'c', event_type: 'assistant_message', sequence_num: 2, output_data: 'the worktree command is handy' }));

    // D: matches in SUMMARY metadata only, no message hit → tier 1 (metadata)
    insertSession(makeSession({ id: 'd', summary: 'worktree notes', project_name: 'projd', started_at: '2025-01-04T00:00:00.000Z' }));
    insertEvent(makeEvent({ session_id: 'd', event_type: 'user_message', sequence_num: 1, input_data: 'unrelated content' }));

    // E: no match anywhere → excluded
    insertSession(makeSession({ id: 'e', summary: 'unrelated', project_name: 'proje', started_at: '2025-01-01T00:00:00.000Z' }));
    insertEvent(makeEvent({ session_id: 'e', event_type: 'user_message', sequence_num: 1, input_data: 'totally different' }));

    // SUB: matches ONLY via a sub-agent message (agent_id NOT NULL) → tier 4
    // (lowest). started_at is the most recent of all, so a correct result ranks
    // it LAST regardless — proving tier dominates the recency tiebreak.
    insertSession(makeSession({ id: 'sub', summary: 'Session Sub', project_name: 'projsub', started_at: '2025-01-06T00:00:00.000Z' }));
    insertEvent(makeEvent({ session_id: 'sub', event_type: 'user_message', sequence_num: 1, input_data: 'main prompt, nothing to see' }));
    insertEvent(makeEvent({ session_id: 'sub', event_type: 'user_message', sequence_num: 2, agent_id: 'agent-x', input_data: 'subagent task about worktree internals' }));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('surfaces sessions matching only by message content, and excludes non-matches', () => {
    const { sessions, total } = listSessions({ q: 'worktree' });
    const ids = sessions.map((s) => s.id);
    assert.ok(!ids.includes('e'), 'session with no match must be excluded');
    assert.deepEqual([...ids].sort(), ['a', 'b', 'c', 'd', 'sub']);
    assert.equal(total, 5);
  });

  it('orders by match tier (name/first-user → other-user → assistant → sub-agent), ties by recency', () => {
    const { sessions } = listSessions({ q: 'worktree' });
    // tier 1: a (first user msg) + d (summary metadata); within tier, started_at DESC → a (05) before d (04)
    // tier 2: b (later user msg); tier 3: c (assistant); tier 4: sub (sub-agent only)
    // 'sub' is the MOST recent (06) yet ranks last — tier dominates recency.
    assert.deepEqual(sessions.map((s) => s.id), ['a', 'd', 'b', 'c', 'sub']);
  });

  it('keeps pagination + total correct under tiered ranking', () => {
    const page1 = listSessions({ q: 'worktree', limit: 2, offset: 0 });
    assert.deepEqual(page1.sessions.map((s) => s.id), ['a', 'd']);
    assert.equal(page1.total, 5);

    const page2 = listSessions({ q: 'worktree', limit: 2, offset: 2 });
    assert.deepEqual(page2.sessions.map((s) => s.id), ['b', 'c']);
    assert.equal(page2.total, 5);
  });

  it('empty query is unchanged: returns all sessions in the default sort', () => {
    const { sessions, total } = listSessions({});
    assert.equal(total, 6);
    // default sort: started_at DESC, id ASC
    assert.deepEqual(sessions.map((s) => s.id), ['sub', 'a', 'd', 'b', 'c', 'e']);
  });

  it('punctuation-only query falls back to metadata search (no FTS, no error)', () => {
    const { sessions, total } = listSessions({ q: '!!!' });
    assert.equal(total, 0, 'no session metadata contains "!!!"');
    assert.equal(sessions.length, 0);
  });
});

describe('getMessageMatchesForSessions', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fts-snippet-test-'));
    getDb(join(tmpDir, 'test.sqlite'));

    insertSession(makeSession({ id: 'u', summary: 'u' }));
    insertEvent(makeEvent({ session_id: 'u', event_type: 'user_message', sequence_num: 1, input_data: 'please set up a worktree for me' }));

    insertSession(makeSession({ id: 'asst', summary: 'asst' }));
    insertEvent(makeEvent({ session_id: 'asst', event_type: 'user_message', sequence_num: 1, input_data: 'nothing here' }));
    insertEvent(makeEvent({ session_id: 'asst', event_type: 'assistant_message', sequence_num: 2, output_data: 'the worktree command does this' }));

    insertSession(makeSession({ id: 'none', summary: 'none' }));
    insertEvent(makeEvent({ session_id: 'none', event_type: 'user_message', sequence_num: 1, input_data: 'unrelated' }));

    // subonly: the ONLY hit is in a sub-agent turn → role 'subagent'
    insertSession(makeSession({ id: 'subonly', summary: 'subonly' }));
    insertEvent(makeEvent({ session_id: 'subonly', event_type: 'user_message', sequence_num: 1, input_data: 'main, unrelated' }));
    insertEvent(makeEvent({ session_id: 'subonly', event_type: 'assistant_message', sequence_num: 2, agent_id: 'agent-y', output_data: 'a sub-agent worktree reply' }));

    // mixed: both a main user turn AND a sub-agent turn match → main wins (role 'user')
    insertSession(makeSession({ id: 'mixed', summary: 'mixed' }));
    insertEvent(makeEvent({ session_id: 'mixed', event_type: 'user_message', sequence_num: 1, input_data: 'my worktree question' }));
    insertEvent(makeEvent({ session_id: 'mixed', event_type: 'user_message', sequence_num: 2, agent_id: 'agent-z', input_data: 'subagent worktree work' }));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty map for empty ids', () => {
    assert.equal(getMessageMatchesForSessions([], '"worktree"*').size, 0);
  });

  it('returns a user-role snippet with the matched token marked', () => {
    const map = getMessageMatchesForSessions(['u', 'asst', 'none'], '"worktree"*');
    const u = map.get('u');
    assert.ok(u, 'user match present');
    assert.equal(u!.role, 'user');
    assert.ok(u!.snippet.includes(SNIPPET_MARK_START) && u!.snippet.includes(SNIPPET_MARK_END), 'snippet wraps the match in sentinels');
    assert.ok(u!.snippet.includes('worktree'), 'snippet contains the matched word');
  });

  it('falls back to an assistant-role snippet when only the assistant matched', () => {
    const map = getMessageMatchesForSessions(['asst'], '"worktree"*');
    const a = map.get('asst');
    assert.ok(a, 'assistant match present');
    assert.equal(a!.role, 'assistant');
  });

  it('omits sessions with no message hit', () => {
    const map = getMessageMatchesForSessions(['none'], '"worktree"*');
    assert.equal(map.has('none'), false);
  });

  it('labels a sub-agent-only hit with role "subagent"', () => {
    const map = getMessageMatchesForSessions(['subonly'], '"worktree"*');
    const s = map.get('subonly');
    assert.ok(s, 'sub-agent match present');
    assert.equal(s!.role, 'subagent');
    assert.ok(s!.snippet.includes('worktree'), 'snippet contains the matched word');
  });

  it('prefers the main-conversation hit over a sub-agent one in the same session', () => {
    const map = getMessageMatchesForSessions(['mixed'], '"worktree"*');
    const m = map.get('mixed');
    assert.ok(m, 'match present');
    assert.equal(m!.role, 'user', 'main user turn wins over the sub-agent turn');
  });
});
