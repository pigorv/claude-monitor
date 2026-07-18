// Route-level coverage for the win32 branch of POST /api/sessions/:id/open-terminal.
// The handler reads process.platform at request time and spawns a real process,
// so the suite in terminal.test.ts skips this path on non-Windows hosts. Here we
// override process.platform to 'win32' and mock child_process.spawn so the
// resolve -> build -> launch -> 200 wiring runs end-to-end on any host. Kept in a
// separate file so the vi.mock stays scoped and doesn't affect the darwin tests.
import { describe, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      // launchWindows resolves on the 'spawn' event; fire it after the route
      // has attached its listeners.
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }),
  };
});

describe('POST /api/sessions/:id/open-terminal (win32)', () => {
  let tmpDir: string;
  let transcriptPath: string;
  let app: ReturnType<typeof createApp>;
  const realPlatform = process.platform;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-win32-test-'));
    transcriptPath = join(tmpDir, 'transcript.jsonl');
    writeFileSync(transcriptPath, '{}\n');
    getDb(join(tmpDir, 'test.sqlite'));
    app = createApp();
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    getDb().exec('DELETE FROM events; DELETE FROM agent_relationships; DELETE FROM sessions;');
  });

  function insertSession(id: string, projectPath: string): void {
    getDb()
      .prepare(`
        INSERT INTO sessions (id, project_path, transcript_path, status, started_at,
          total_input_tokens, total_output_tokens, total_cache_read_tokens,
          total_cache_write_tokens, compaction_count, tool_call_count, subagent_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        projectPath,
        transcriptPath,
        'completed',
        '2026-01-15T10:00:00Z',
        100,
        50,
        0,
        0,
        0,
        0,
        0,
      );
  }

  it('returns 200 and spawns the chosen terminal for an explicit pref', async () => {
    insertSession('sess-win', 'C:\\Users\\proj');
    const res = await app.request('/api/sessions/sess-win/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'cmd' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success: boolean; terminal: string };
    assert.equal(body.success, true);
    assert.equal(body.terminal, 'cmd');

    const spawnMock = vi.mocked(spawn);
    assert.equal(spawnMock.mock.calls.length, 1);
    const [exe, args] = spawnMock.mock.calls[0];
    assert.equal(exe, 'cmd.exe');
    assert.deepEqual(args, [
      '/D',
      '/K',
      `cd /d "C:\\Users\\proj" && claude --resume sess-win`,
    ]);
  });

  it('returns 410 transcript_deleted when the transcript is gone, without spawning', async () => {
    getDb()
      .prepare(`
        INSERT INTO sessions (id, project_path, transcript_path, status, started_at,
          total_input_tokens, total_output_tokens, total_cache_read_tokens,
          total_cache_write_tokens, compaction_count, tool_call_count, subagent_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'sess-gone',
        'C:\\Users\\proj',
        join(tmpDir, 'does-not-exist.jsonl'),
        'completed',
        '2026-01-15T10:00:00Z',
        100,
        50,
        0,
        0,
        0,
        0,
        0,
      );
    const res = await app.request('/api/sessions/sess-gone/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'cmd' }),
    });
    assert.equal(res.status, 410);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'transcript_deleted');
    assert.ok(body.message.length > 0);
    assert.equal(vi.mocked(spawn).mock.calls.length, 0);
  });

  it('returns 500 invalid_project_path when the path has an unsupported char', async () => {
    insertSession('sess-bad', 'C:\\bad"path');
    const res = await app.request('/api/sessions/sess-bad/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'cmd' }),
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'invalid_project_path');
    assert.equal(vi.mocked(spawn).mock.calls.length, 0);
  });
});
