import { describe, it, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { upsertSession } from '../../src/db/queries/sessions.js';
import { createApp } from '../../src/server/app.js';
import type { Session, SessionListResponse, SessionDetailResponse } from '../../src/shared/types.js';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    project_path: '/home/user/myproject',
    project_name: 'myproject',
    model: 'claude-sonnet-4-20250514',
    source: 'startup',
    status: 'completed',
    started_at: '2026-01-15T10:00:00Z',
    ended_at: '2026-01-15T10:30:00Z',
    duration_ms: 1800000,
    total_input_tokens: 5000,
    total_output_tokens: 3000,
    total_cache_read_tokens: 1000,
    total_cache_write_tokens: 500,
    peak_context_pct: 0.45,
    compaction_count: 1,
    tool_call_count: 10,
    subagent_count: 2,
    risk_score: 0.35,
    summary: 'Implemented feature X',
    end_reason: 'user_exit',
    transcript_path: '/tmp/transcript.jsonl',
    metadata: null,
    ...overrides,
  };
}

describe('Sessions routes', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sessions-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    const db = getDb(dbPath);

    // Insert test sessions
    const insertSession = db.prepare(`
      INSERT INTO sessions (
        id, project_path, project_name, model, source, status, started_at, ended_at,
        duration_ms, total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, peak_context_pct, compaction_count, tool_call_count,
        subagent_count, risk_score, summary, end_reason, transcript_path, metadata
      ) VALUES (
        @id, @project_path, @project_name, @model, @source, @status, @started_at, @ended_at,
        @duration_ms, @total_input_tokens, @total_output_tokens, @total_cache_read_tokens,
        @total_cache_write_tokens, @peak_context_pct, @compaction_count, @tool_call_count,
        @subagent_count, @risk_score, @summary, @end_reason, @transcript_path, @metadata
      )
    `);

    insertSession.run(makeSession());
    insertSession.run(makeSession({
      id: 'sess-2',
      project_name: 'other-project',
      project_path: '/home/user/other-project',
      model: 'claude-opus-4-20250514',
      status: 'running',
      started_at: '2026-01-16T10:00:00Z',
      risk_score: 0.75,
      summary: 'Debugging issue Y',
    }));
    insertSession.run(makeSession({
      id: 'sess-3',
      status: 'imported',
      started_at: '2026-01-14T08:00:00Z',
      risk_score: 0.1,
      model: 'claude-sonnet-4-20250514',
      summary: 'Quick fix',
    }));

    // Insert events for sess-1
    const insertEvent = db.prepare(`
      INSERT INTO events (
        session_id, event_type, event_source, tool_name, timestamp, sequence_num,
        input_tokens, output_tokens, cache_read_tokens, context_pct, duration_ms,
        input_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertEvent.run('sess-1', 'tool_call_start', 'transcript_import', 'Read', '2026-01-15T10:01:00Z', 1, 100, 50, 10, 0.1, 200, '{"file_path":"/src/main.ts"}');
    insertEvent.run('sess-1', 'tool_call_start', 'transcript_import', 'Write', '2026-01-15T10:02:00Z', 2, 200, 100, 20, 0.2, 300, '{"file_path":"/src/output.ts"}');
    insertEvent.run('sess-1', 'compaction', 'transcript_import', null, '2026-01-15T10:05:00Z', 3, 500, 200, 50, 0.5, null, null);

    // Insert agent relationship for sess-1
    db.prepare(`
      INSERT INTO agent_relationships (
        parent_session_id, child_agent_id, status, tool_call_count
      ) VALUES (?, ?, ?, ?)
    `).run('sess-1', 'agent-abc', 'completed', 5);

    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── GET /api/sessions ──

  it('returns correct list shape', async () => {
    const res = await app.request('/api/sessions');
    assert.equal(res.status, 200);
    const body: SessionListResponse = await res.json();
    assert.ok(Array.isArray(body.sessions));
    assert.equal(typeof body.total, 'number');
    assert.equal(typeof body.limit, 'number');
    assert.equal(typeof body.offset, 'number');
    assert.equal(body.total, 3);
    assert.equal(body.sessions.length, 3);
  });

  it('session summaries have correct fields', async () => {
    const res = await app.request('/api/sessions');
    const body: SessionListResponse = await res.json();
    const s = body.sessions.find((s) => s.id === 'sess-1')!;
    assert.ok(s);
    assert.equal(s.project_name, 'myproject');
    assert.equal(s.model, 'claude-sonnet-4-20250514');
    assert.equal(s.status, 'completed');
    assert.equal(s.duration_ms, 1800000);
    assert.equal(s.risk_score, 0.35);
    assert.equal(s.risk_level, 'medium');
    assert.equal(s.summary, 'Implemented feature X');
  });

  it('filters by status', async () => {
    const res = await app.request('/api/sessions?status=running');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].id, 'sess-2');
  });

  it('filters by model', async () => {
    const res = await app.request('/api/sessions?model=opus');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].id, 'sess-2');
  });

  it('filters by project', async () => {
    const res = await app.request('/api/sessions?project=other-project');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].id, 'sess-2');
  });

  it('filters by date range (since/until)', async () => {
    const res = await app.request('/api/sessions?since=2026-01-15T00:00:00Z&until=2026-01-15T23:59:59Z');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].id, 'sess-1');
  });

  it('filters by min_risk', async () => {
    const res = await app.request('/api/sessions?min_risk=0.5');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].id, 'sess-2');
  });

  it('sorts by risk_score ascending', async () => {
    const res = await app.request('/api/sessions?sort=risk_score&order=asc');
    const body: SessionListResponse = await res.json();
    assert.equal(body.sessions[0].id, 'sess-3');
    assert.equal(body.sessions[2].id, 'sess-2');
  });

  it('respects limit and offset', async () => {
    const res = await app.request('/api/sessions?limit=1&offset=0');
    const body: SessionListResponse = await res.json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.total, 3);
    assert.equal(body.limit, 1);
    assert.equal(body.offset, 0);

    const res2 = await app.request('/api/sessions?limit=1&offset=1');
    const body2: SessionListResponse = await res2.json();
    assert.equal(body2.sessions.length, 1);
    assert.notEqual(body2.sessions[0].id, body.sessions[0].id);
  });

  it('defaults null fields in summaries', async () => {
    // Insert a session with many null fields
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_write_tokens, compaction_count, tool_call_count, subagent_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-null', '/tmp', 'running', '2026-01-17T00:00:00Z', 0, 0, 0, 0, 0, 0, 0);

    const res = await app.request('/api/sessions?status=running&sort=started_at&order=desc');
    const body: SessionListResponse = await res.json();
    const s = body.sessions.find((s) => s.id === 'sess-null')!;
    assert.ok(s);
    assert.equal(s.project_name, 'unknown');
    assert.equal(s.model, 'unknown');
    assert.equal(s.duration_ms, 0);
    assert.equal(s.peak_context_pct, 0);
    assert.equal(s.risk_score, 0);
    assert.equal(s.risk_level, 'low');
    assert.equal(s.summary, '');

    // Clean up
    db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-null');
  });

  // ── Risk level computation ──

  it('computes risk levels correctly', async () => {
    const res = await app.request('/api/sessions?sort=risk_score&order=asc');
    const body: SessionListResponse = await res.json();
    const levels = body.sessions.map((s) => ({ id: s.id, level: s.risk_level }));
    assert.equal(levels.find((l) => l.id === 'sess-3')!.level, 'low');
    assert.equal(levels.find((l) => l.id === 'sess-1')!.level, 'medium');
    assert.equal(levels.find((l) => l.id === 'sess-2')!.level, 'high');
  });

  // ── GET /api/sessions/:id ──

  it('returns full session detail', async () => {
    const res = await app.request('/api/sessions/sess-1');
    assert.equal(res.status, 200);
    const body: SessionDetailResponse = await res.json();

    // Session object
    assert.equal(body.session.id, 'sess-1');
    assert.equal(body.session.project_name, 'myproject');

    // Token timeline
    assert.ok(Array.isArray(body.token_timeline));
    assert.ok(body.token_timeline.length > 0);
    assert.equal(typeof body.token_timeline[0].input_tokens, 'number');
    assert.equal(typeof body.token_timeline[0].context_pct, 'number');

    // Agents
    assert.ok(Array.isArray(body.agents));
    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].child_agent_id, 'agent-abc');

    // Risk
    assert.equal(body.risk.score, 0.35);
    assert.equal(body.risk.level, 'medium');
    assert.ok(Array.isArray(body.risk.signals));

    // Stats
    assert.ok(Array.isArray(body.stats.unique_tools));
    assert.ok(body.stats.unique_tools.includes('Read'));
    assert.ok(body.stats.unique_tools.includes('Write'));
    assert.equal(typeof body.stats.tool_frequency, 'object');
    assert.equal(body.stats.tool_frequency['Read'], 1);
    assert.equal(typeof body.stats.avg_tool_duration_ms, 'number');
    assert.ok(Array.isArray(body.stats.files_read));
    assert.ok(Array.isArray(body.stats.files_written));
  });

  it('returns 404 for unknown session', async () => {
    const res = await app.request('/api/sessions/nonexistent');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Session not found');
  });

  it('returns empty token_timeline for session with no events', async () => {
    const res = await app.request('/api/sessions/sess-3');
    assert.equal(res.status, 200);
    const body: SessionDetailResponse = await res.json();
    assert.equal(body.token_timeline.length, 0);
    assert.equal(body.agents.length, 0);
  });

  // ── Cost estimation ──

  it('includes cost_estimate_usd for known models', async () => {
    const res = await app.request('/api/sessions');
    const body: SessionListResponse = await res.json();
    const sonnet = body.sessions.find((s) => s.id === 'sess-1')!;
    const opus = body.sessions.find((s) => s.id === 'sess-2')!;

    // Sonnet: (5000/1M)*3 + (3000/1M)*15 = 0.015 + 0.045 = 0.06
    assert.equal(typeof sonnet.cost_estimate_usd, 'number');
    assert.equal(sonnet.cost_estimate_usd, 0.06);

    // Opus: (5000/1M)*15 + (3000/1M)*75 = 0.075 + 0.225 = 0.3
    assert.equal(typeof opus.cost_estimate_usd, 'number');
    assert.equal(opus.cost_estimate_usd, 0.3);
  });

  it('cost_estimate_usd is undefined for unknown models', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at, model,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-unknown-model', '/tmp', 'completed', '2026-01-18T00:00:00Z', 'gpt-4o', 1000, 500, 0, 0, 0, 0, 0);

    const res = await app.request('/api/sessions');
    const body: SessionListResponse = await res.json();
    const s = body.sessions.find((s) => s.id === 'sess-unknown-model')!;
    assert.ok(s);
    assert.equal(s.cost_estimate_usd, undefined);

    db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-unknown-model');
  });

  // ── Mini timeline / sparkline data ──

  it('includes mini_timeline in session summaries', async () => {
    const res = await app.request('/api/sessions');
    const body: SessionListResponse = await res.json();
    const s = body.sessions.find((s) => s.id === 'sess-1')!;
    assert.ok(Array.isArray(s.mini_timeline));
    // sess-1 has 3 events with context_pct values
    assert.ok(s.mini_timeline.length > 0);
    for (const point of s.mini_timeline) {
      assert.equal(typeof point.context_pct, 'number');
      assert.equal(typeof point.is_compaction, 'boolean');
    }
  });

  it('mini_timeline marks compaction events', async () => {
    const res = await app.request('/api/sessions');
    const body: SessionListResponse = await res.json();
    const s = body.sessions.find((s) => s.id === 'sess-1')!;
    const compactions = s.mini_timeline.filter((p) => p.is_compaction);
    assert.ok(compactions.length >= 1);
  });

  // ── Search (q parameter) ──

  it('filters by search query on project_name', async () => {
    const res = await app.request('/api/sessions?q=myproject');
    const body: SessionListResponse = await res.json();
    assert.ok(body.sessions.some((s) => s.project_name === 'myproject'));
    assert.ok(!body.sessions.some((s) => s.project_name === 'other-project'));
  });

  it('filters by search query on summary', async () => {
    const res = await app.request('/api/sessions?q=Debugging');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].id, 'sess-2');
  });

  it('search query is case-insensitive via LIKE', async () => {
    const res = await app.request('/api/sessions?q=quick');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.sessions[0].id, 'sess-3');
  });

  it('search returns empty for no matches', async () => {
    const res = await app.request('/api/sessions?q=nonexistent-xyzzy');
    const body: SessionListResponse = await res.json();
    assert.equal(body.total, 0);
    assert.equal(body.sessions.length, 0);
  });

  // ── Compaction details in session detail ──

  it('session detail includes compaction_details', async () => {
    const res = await app.request('/api/sessions/sess-1');
    assert.equal(res.status, 200);
    const body: SessionDetailResponse = await res.json();
    assert.ok(Array.isArray(body.compaction_details));
    assert.equal(body.compaction_details.length, 1);
    const detail = body.compaction_details[0];
    assert.equal(typeof detail.event_id, 'number');
    assert.equal(typeof detail.timestamp, 'string');
    assert.equal(typeof detail.tokens_before, 'number');
    assert.equal(typeof detail.tokens_after, 'number');
    assert.ok(detail.trigger === 'auto' || detail.trigger === 'manual');
    assert.ok(Array.isArray(detail.likely_dropped));
  });

  // ── Agent internal tool calls ──

  it('session detail includes internal_tool_calls on agents', async () => {
    // Add agent events with tools
    const db = getDb();
    db.prepare(`
      INSERT INTO events (session_id, event_type, event_source, tool_name, timestamp,
        sequence_num, agent_id, duration_ms, input_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess-1', 'tool_call_start', 'transcript_import', 'Read', '2026-01-15T10:03:00Z', 4,
      'agent-abc', 150, '{"file_path":"/src/utils.ts"}');

    const res = await app.request('/api/sessions/sess-1');
    const body: SessionDetailResponse = await res.json();
    const agent = body.agents.find((a) => a.child_agent_id === 'agent-abc')!;
    assert.ok(agent);
    assert.ok(Array.isArray(agent.internal_tool_calls));
    assert.ok(agent.internal_tool_calls.length >= 1);
    const toolCall = agent.internal_tool_calls.find((tc) => tc.file_path === '/src/utils.ts')!;
    assert.ok(toolCall);
    assert.equal(toolCall.tool_name, 'Read');
    assert.equal(toolCall.duration_ms, 150);
  });

  // ── Event count in session detail ──

  it('session detail includes event_count', async () => {
    const res = await app.request('/api/sessions/sess-1');
    const body: SessionDetailResponse = await res.json();
    assert.equal(typeof body.event_count, 'number');
    assert.ok(body.event_count >= 3); // We inserted at least 3 events
  });
});

// ── Sessions route: corrupt metadata ──────────────────────────────────

describe('Sessions route: corrupt metadata handling', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'corrupt-meta-'));
    getDb(join(tmpDir, 'test.sqlite'));
    app = createApp();

    const session = {
      id: 'corrupt-meta-1',
      project_path: '/tmp/proj',
      project_name: 'proj',
      model: 'sonnet',
      models_used: null,
      source: null,
      status: 'imported',
      started_at: '2026-03-12T10:00:00.000Z',
      ended_at: '2026-03-12T10:30:00.000Z',
      duration_ms: 1800000,
      total_input_tokens: 5000,
      total_output_tokens: 1000,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      peak_context_pct: 25.0,
      compaction_count: 0,
      tool_call_count: 5,
      subagent_count: 0,
      risk_score: 0.2,
      summary: 'test session',
      end_reason: null,
      transcript_path: '/tmp/t.jsonl',
      metadata: 'this is {not valid json!!!',
    } as unknown as Session;
    upsertSession(session);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles corrupt metadata without crashing', async () => {
    const res = await app.request('/api/sessions/corrupt-meta-1');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session.id, 'corrupt-meta-1');
    assert.deepEqual(body.risk.signals, []);
  });
});
