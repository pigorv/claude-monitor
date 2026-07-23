import { describe, it, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The clone writes to `<CONFIG.claudeProjectsPath>/<slug>/<newId>.jsonl`, and
// CONFIG is frozen at first import of src/shared/constants.ts. Point the
// projects path at a throwaway temp dir BEFORE any app module (which would
// transitively load constants) is imported — hence the fully dynamic imports
// below. This test file has NO static imports of `src/**`, so nothing loads
// constants until beforeAll runs.
const TEST_DIR = join(tmpdir(), `claude-monitor-clone-test-${Date.now()}`);
const PROJECTS_DIR = join(TEST_DIR, 'projects');
const DB_PATH = join(TEST_DIR, 'test.sqlite');
process.env.CLAUDE_MONITOR_PROJECTS_PATH = PROJECTS_DIR;

// Loaded in beforeAll (dynamic, post-env-set).
let cloneSession: typeof import('../../src/clone/session-clone.js').cloneSession;
let encodeProjectDirName: typeof import('../../src/clone/session-clone.js').encodeProjectDirName;
let CloneError: typeof import('../../src/clone/session-clone.js').CloneError;
let getDb: typeof import('../../src/db/connection.js').getDb;
let closeDb: typeof import('../../src/db/connection.js').closeDb;
let upsertSession: typeof import('../../src/db/queries/sessions.js').upsertSession;
let getSession: typeof import('../../src/db/queries/sessions.js').getSession;
type Session = import('../../src/shared/types.js').Session;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A parent transcript whose every non-blank line is a JSON object carrying a
// `sessionId` and a `cwd`, plus fields that must survive verbatim
// (`uuid`, `parentUuid`, `leafUuid`, message content, usage).
const SOURCE_ID = 'src-session-001';
const SOURCE_CWD = '/tmp/source-project';
const PARENT_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: SOURCE_CWD, sessionId: SOURCE_ID, version: '2.1.0',
    type: 'system', subtype: 'turn_duration', durationMs: 5000,
    timestamp: '2026-01-01T00:00:00.000Z', uuid: 'uuid-sys-1',
  }),
  JSON.stringify({
    parentUuid: null, cwd: SOURCE_CWD, sessionId: SOURCE_ID, version: '2.1.0',
    type: 'user', message: { role: 'user', content: 'Read the config at /tmp/source-project/config.json.' },
    timestamp: '2026-01-01T00:01:00.000Z', uuid: 'uuid-user-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-user-1', cwd: SOURCE_CWD, sessionId: SOURCE_ID, version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Reading the config file now.', signature: 'sig-abc' },
        { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/source-project/config.json' } },
      ],
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 },
    },
    timestamp: '2026-01-01T00:01:05.000Z', uuid: 'uuid-asst-1',
  }),
  JSON.stringify({
    type: 'summary', summary: 'Read project config', leafUuid: 'uuid-asst-1',
    cwd: SOURCE_CWD, sessionId: SOURCE_ID,
  }),
].join('\n');

// Two subagent transcripts under the source `subagents/` subtree: one flat
// (`agent-x.jsonl`) and one nested (`workflows/wf-run-01/agent-y.jsonl`). Each
// carries its OWN sessionId (which must survive the clone) and a `cwd` (which
// must be repointed at the target).
const SUB_X_ID = 'sub-agent-x-001';
const SUB_Y_ID = 'sub-agent-y-002';
const SUB_X_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: SOURCE_CWD, sessionId: SUB_X_ID, version: '2.1.0',
    type: 'user', message: { role: 'user', content: 'Subagent X: inspect the tree.' },
    timestamp: '2026-01-01T00:02:00.000Z', uuid: 'uuid-subx-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-subx-1', cwd: SOURCE_CWD, sessionId: SUB_X_ID, version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Done inspecting.' }],
      usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:02:05.000Z', uuid: 'uuid-subx-2',
  }),
].join('\n');
const SUB_Y_JSONL = [
  JSON.stringify({
    parentUuid: null, cwd: SOURCE_CWD, sessionId: SUB_Y_ID, version: '2.1.0',
    type: 'user', message: { role: 'user', content: 'Subagent Y: run the workflow.' },
    timestamp: '2026-01-01T00:03:00.000Z', uuid: 'uuid-suby-1',
  }),
  JSON.stringify({
    parentUuid: 'uuid-suby-1', cwd: SOURCE_CWD, sessionId: SUB_Y_ID, version: '2.1.0',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-6', role: 'assistant',
      content: [{ type: 'text', text: 'Workflow complete.' }],
      usage: { input_tokens: 250, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: '2026-01-01T00:03:05.000Z', uuid: 'uuid-suby-2',
  }),
].join('\n');

/** Seed a sessions row pointing at a real transcript so getSession resolves. */
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

/** Write the parent transcript to disk and return its path. */
function layOutParent(): string {
  const projDir = join(TEST_DIR, 'srcproj');
  mkdirSync(projDir, { recursive: true });
  const parentPath = join(projDir, `${SOURCE_ID}.jsonl`);
  writeFileSync(parentPath, PARENT_JSONL);
  return parentPath;
}

/**
 * Lay out the source `subagents/` subtree next to the parent transcript:
 *   <sessionDir>/subagents/agent-x.jsonl                      (flat)
 *   <sessionDir>/subagents/workflows/wf-run-01/agent-y.jsonl  (nested)
 * where <sessionDir> == <dirname(parentPath)>/<SOURCE_ID>.
 */
function layOutSubagents(parentPath: string): void {
  const sessionDir = join(parentPath.slice(0, -'.jsonl'.length));
  const subagentsDir = join(sessionDir, 'subagents');
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(join(subagentsDir, 'agent-x.jsonl'), SUB_X_JSONL);
  const nestedDir = join(subagentsDir, 'workflows', 'wf-run-01');
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(nestedDir, 'agent-y.jsonl'), SUB_Y_JSONL);
}

beforeAll(async () => {
  ({ cloneSession, encodeProjectDirName, CloneError } = await import('../../src/clone/session-clone.js'));
  ({ getDb, closeDb } = await import('../../src/db/connection.js'));
  ({ upsertSession, getSession } = await import('../../src/db/queries/sessions.js'));
});

describe('encodeProjectDirName', () => {
  it('maps /home/user/claude-monitor to -home-user-claude-monitor', () => {
    // The verified on-disk case.
    assert.equal(encodeProjectDirName('/home/user/claude-monitor'), '-home-user-claude-monitor');
  });

  it('replaces dots and underscores (and every other non-alphanumeric) with -', () => {
    assert.equal(encodeProjectDirName('/home/user/my_app.v2'), '-home-user-my-app-v2');
    assert.equal(encodeProjectDirName('/a.b_c/d'), '-a-b-c-d');
    assert.equal(encodeProjectDirName('/Users/Jane/Code-123'), '-Users-Jane-Code-123');
  });
});

describe('cloneSession', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(PROJECTS_DIR, { recursive: true });
    getDb(DB_PATH);
  });

  afterEach(() => {
    closeDb();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Source-resolution guards (mirror session-bundle) ────────────────

  it('throws an actionable CloneError for an unknown session id', async () => {
    await assert.rejects(
      () => cloneSession('does-not-exist', { targetDir: TEST_DIR }),
      (err: Error) => {
        assert.ok(err instanceof CloneError);
        assert.match(err.message, /does-not-exist/);
        assert.match(err.message, /no such session|import/i);
        return true;
      },
    );
  });

  it('throws when transcript_path is null', async () => {
    seedSessionRow('null-path', null);
    await assert.rejects(
      () => cloneSession('null-path', { targetDir: TEST_DIR }),
      (err: Error) => {
        assert.ok(err instanceof CloneError);
        assert.match(err.message, /transcript/i);
        return true;
      },
    );
  });

  it('throws when the transcript file is gone', async () => {
    seedSessionRow('gone', join(TEST_DIR, 'nope.jsonl'));
    await assert.rejects(
      () => cloneSession('gone', { targetDir: TEST_DIR }),
      (err: Error) => {
        assert.ok(err instanceof CloneError);
        assert.match(err.message, /no longer exists|raw transcript/i);
        return true;
      },
    );
  });

  // ── Target-dir guard (validated before any write) ───────────────────

  it('rejects a blank targetDir and writes nothing', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);
    await assert.rejects(
      () => cloneSession(SOURCE_ID, { targetDir: '   ' }),
      (err: Error) => {
        assert.ok(err instanceof CloneError);
        assert.match(err.message, /non-empty|required/i);
        return true;
      },
    );
  });

  it('rejects a relative targetDir', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);
    await assert.rejects(
      () => cloneSession(SOURCE_ID, { targetDir: 'relative/dir' }),
      (err: Error) => {
        assert.ok(err instanceof CloneError);
        assert.match(err.message, /absolute/i);
        return true;
      },
    );
  });

  it('rejects a targetDir that does not exist', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);
    await assert.rejects(
      () => cloneSession(SOURCE_ID, { targetDir: join(TEST_DIR, 'no-such-dir') }),
      (err: Error) => {
        assert.ok(err instanceof CloneError);
        assert.match(err.message, /not an existing directory/i);
        return true;
      },
    );
  });

  it('rejects a targetDir that is a file, not a directory', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);
    const filePath = join(TEST_DIR, 'a-file.txt');
    writeFileSync(filePath, 'hi');
    await assert.rejects(
      () => cloneSession(SOURCE_ID, { targetDir: filePath }),
      (err: Error) => {
        assert.ok(err instanceof CloneError);
        assert.match(err.message, /not an existing directory/i);
        return true;
      },
    );
  });

  // ── Happy path: path/slug, new id, and line rewrite ─────────────────

  it('writes <newId>.jsonl under the target slug, rewriting sessionId/cwd only', async () => {
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);

    // An existing directory to root the clone in.
    const targetDir = join(TEST_DIR, 'dest-project');
    mkdirSync(targetDir, { recursive: true });

    const { id: newId, projectPath } = await cloneSession(SOURCE_ID, { targetDir });

    // New id is a UUID, distinct from the source.
    assert.match(newId, UUID_RE);
    assert.notEqual(newId, SOURCE_ID);
    assert.equal(projectPath, targetDir);

    // Output lands at the expected slug-derived path.
    const expectedPath = join(PROJECTS_DIR, encodeProjectDirName(targetDir), `${newId}.jsonl`);
    const written = readFileSync(expectedPath, 'utf8');
    const outLines = written.split('\n').filter((l) => l.length > 0);
    const srcLines = PARENT_JSONL.split('\n');
    assert.equal(outLines.length, srcLines.length);

    for (let i = 0; i < outLines.length; i++) {
      const outObj = JSON.parse(outLines[i]) as Record<string, unknown>;
      const srcObj = JSON.parse(srcLines[i]) as Record<string, unknown>;

      // sessionId rewritten on every line; cwd repointed at targetDir.
      assert.equal(outObj.sessionId, newId);
      assert.equal(outObj.cwd, targetDir);

      // Every other field is byte-identical: strip the two rewritten keys and
      // deep-compare the remainder.
      delete outObj.sessionId;
      delete outObj.cwd;
      delete srcObj.sessionId;
      delete srcObj.cwd;
      assert.deepEqual(outObj, srcObj, `line ${i} preserves all other fields verbatim`);
    }

    // leafUuid / uuid / parentUuid are NOT reminted (spot-check the summary).
    const summaryOut = JSON.parse(outLines[outLines.length - 1]) as Record<string, unknown>;
    assert.equal(summaryOut.leafUuid, 'uuid-asst-1');
  });

  it('expands a leading ~ in targetDir to the home directory', async () => {
    // homedir() is an existing directory, so `~` alone is a valid target and
    // its slug must match the expanded absolute path.
    const parentPath = layOutParent();
    seedSessionRow(SOURCE_ID, parentPath);

    const { id: newId, projectPath } = await cloneSession(SOURCE_ID, { targetDir: '~' });
    const { homedir } = await import('node:os');
    assert.equal(projectPath, homedir());
    const expectedPath = join(PROJECTS_DIR, encodeProjectDirName(homedir()), `${newId}.jsonl`);
    assert.ok(readFileSync(expectedPath, 'utf8').length > 0);
  });

  // ── Subagent subtree copy + synchronous import (Behavior #3, #4) ─────

  it('copies the subagents/ subtree at the right depth (cwd rewritten, sessionId preserved) and imports the clone', async () => {
    const parentPath = layOutParent();
    layOutSubagents(parentPath);
    seedSessionRow(SOURCE_ID, parentPath);

    const targetDir = join(TEST_DIR, 'dest-project');
    mkdirSync(targetDir, { recursive: true });

    const { id: newId, projectPath } = await cloneSession(SOURCE_ID, { targetDir });
    assert.equal(projectPath, targetDir);

    const cloneSlugDir = join(PROJECTS_DIR, encodeProjectDirName(targetDir));

    // Each child is written under <slug>/<newId>/subagents/<relpath> at the
    // SAME relative depth as the source (flat + nested workflow dir).
    const checks: Array<{ rel: string; expectSessionId: string; body: string }> = [
      { rel: 'agent-x.jsonl', expectSessionId: SUB_X_ID, body: SUB_X_JSONL },
      { rel: join('workflows', 'wf-run-01', 'agent-y.jsonl'), expectSessionId: SUB_Y_ID, body: SUB_Y_JSONL },
    ];
    for (const { rel, expectSessionId, body } of checks) {
      const childPath = join(cloneSlugDir, newId, 'subagents', rel);
      const outLines = readFileSync(childPath, 'utf8').split('\n').filter((l) => l.length > 0);
      const srcLines = body.split('\n');
      assert.equal(outLines.length, srcLines.length, `child ${rel} preserves line count`);

      for (let i = 0; i < outLines.length; i++) {
        const outObj = JSON.parse(outLines[i]) as Record<string, unknown>;
        const srcObj = JSON.parse(srcLines[i]) as Record<string, unknown>;
        // sessionId is the child's OWN id, untouched; cwd repointed at target.
        assert.equal(outObj.sessionId, expectSessionId, `child ${rel} keeps its own sessionId`);
        assert.equal(outObj.cwd, targetDir, `child ${rel} cwd rewritten to target`);
        // Everything else byte-identical.
        delete outObj.cwd;
        delete srcObj.cwd;
        assert.deepEqual(outObj, srcObj, `child ${rel} line ${i} preserves all other fields`);
      }
    }

    // The clone landed in the DB before returning (Behavior #4): getSession
    // resolves it with project_path === targetDir.
    const record = getSession(newId);
    assert.ok(record, 'clone is importable — getSession(newId) returns a record');
    assert.equal(record.project_path, targetDir);
  });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});
