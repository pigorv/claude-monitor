import { describe, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The clone writes to `<CONFIG.claudeProjectsPath>/<slug>/<newId>.jsonl`, and
// CONFIG is frozen at first import of src/shared/constants.ts. Point the
// projects path at a throwaway temp dir BEFORE any app module (which would
// transitively load constants) is imported — hence the fully dynamic imports
// below. This file has NO static imports of `src/**`.
const TEST_DIR = join(tmpdir(), `claude-monitor-clone-route-${Date.now()}`);
const PROJECTS_DIR = join(TEST_DIR, 'projects');
const DB_PATH = join(TEST_DIR, 'test.sqlite');
process.env.CLAUDE_MONITOR_PROJECTS_PATH = PROJECTS_DIR;

let createApp: typeof import('../../src/server/app.js').createApp;
let encodeProjectDirName: typeof import('../../src/clone/session-clone.js').encodeProjectDirName;
let getDb: typeof import('../../src/db/connection.js').getDb;
let closeDb: typeof import('../../src/db/connection.js').closeDb;
let upsertSession: typeof import('../../src/db/queries/sessions.js').upsertSession;
type Session = import('../../src/shared/types.js').Session;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_ID = 'src-session-route-001';
const SOURCE_CWD = '/tmp/source-project';
const PARENT_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: SOURCE_CWD, sessionId: SOURCE_ID, version: '2.1.0',
    type: 'user', message: { role: 'user', content: 'hello' },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'uuid-user-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-user-1', cwd: SOURCE_CWD, sessionId: SOURCE_ID, version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'uuid-asst-1',
  }),
].join('\n');

function seedSessionRow(id: string, transcriptPath: string | null): void {
  const row: Session = {
    id,
    project_path: SOURCE_CWD,
    project_name: 'source-project',
    model: 'claude-opus-4-6',
    models_used: null,
    source: 'transcript_import',
    status: 'completed',
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: null,
    duration_ms: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_input_tokens_billed: 0,
    total_cache_write_5m_tokens: 0,
    total_cache_write_1h_tokens: 0,
    peak_context_pct: null,
    compaction_count: 0,
    tool_call_count: 0,
    subagent_count: 0,
    summary: null,
    end_reason: null,
    transcript_path: transcriptPath as unknown as string,
    metadata: null,
    invocations: null,
    started_with: null,
    agent_avg_compression: null,
    agent_total_tokens: 0,
    agent_pressure_events: 0,
    agent_compacted_count: 0,
    peak_concurrency: 0,
  };
  upsertSession(row);
}

function layOutParent(): string {
  const projDir = join(TEST_DIR, 'srcproj');
  mkdirSync(projDir, { recursive: true });
  const parentPath = join(projDir, `${SOURCE_ID}.jsonl`);
  writeFileSync(parentPath, PARENT_JSONL);
  return parentPath;
}

beforeAll(async () => {
  ({ createApp } = await import('../../src/server/app.js'));
  ({ encodeProjectDirName } = await import('../../src/clone/session-clone.js'));
  ({ getDb, closeDb } = await import('../../src/db/connection.js'));
  ({ upsertSession } = await import('../../src/db/queries/sessions.js'));
});

describe('Session clone route (POST /api/sessions/:id/clone)', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(PROJECTS_DIR, { recursive: true });
    getDb(DB_PATH);
    app = createApp();
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns { id, projectPath } for a valid clone', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);

    const targetDir = join(TEST_DIR, 'dest-project');
    mkdirSync(targetDir, { recursive: true });

    const res = await app.request(`/api/sessions/${SOURCE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDir }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.id, UUID_RE);
    assert.notEqual(body.id, SOURCE_ID);
    assert.equal(body.projectPath, targetDir);

    // The clone was actually written under the target slug.
    const expectedPath = join(PROJECTS_DIR, encodeProjectDirName(targetDir), `${body.id}.jsonl`);
    assert.ok(existsSync(expectedPath), 'clone transcript exists on disk');
  });

  it('returns 400 for a missing targetDir and writes nothing', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);

    const res = await app.request(`/api/sessions/${SOURCE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /required|non-empty/i);

    // No slug dir was created under the projects path.
    assert.deepEqual(readdirSync(PROJECTS_DIR), []);
  });

  it('returns 400 for a nonexistent targetDir and writes nothing', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);

    const nonexistent = join(TEST_DIR, 'no-such-dir');
    const res = await app.request(`/api/sessions/${SOURCE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDir: nonexistent }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not an existing directory/i);
    assert.deepEqual(readdirSync(PROJECTS_DIR), []);
  });

  it('returns 404 for an unknown session', async () => {
    const targetDir = join(TEST_DIR, 'dest-project');
    mkdirSync(targetDir, { recursive: true });

    const res = await app.request('/api/sessions/does-not-exist/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDir }),
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.match(body.error, /no such session/i);
  });

  it('returns 410 when the source transcript is gone', async () => {
    seedSessionRow('gone', join(TEST_DIR, 'nope.jsonl'));
    const targetDir = join(TEST_DIR, 'dest-project');
    mkdirSync(targetDir, { recursive: true });

    const res = await app.request('/api/sessions/gone/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDir }),
    });

    assert.equal(res.status, 410);
    const body = await res.json();
    assert.match(body.error, /no longer exists|raw transcript/i);
  });

  it('returns 410 when transcript_path was never recorded', async () => {
    seedSessionRow('null-path', null);
    const targetDir = join(TEST_DIR, 'dest-project');
    mkdirSync(targetDir, { recursive: true });

    const res = await app.request('/api/sessions/null-path/clone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetDir }),
    });

    assert.equal(res.status, 410);
    const body = await res.json();
    assert.match(body.error, /transcript path was never recorded|re-import/i);
  });

  it('does not let /api/sessions/:id shadow the /clone sub-route', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);

    // The detail route is a GET; the clone route is a POST at .../clone.
    const detail = await app.request(`/api/sessions/${SOURCE_ID}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.headers.get('content-type')?.includes('application/json'));
  });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});
