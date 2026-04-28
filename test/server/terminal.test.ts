import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb, closeDb } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import {
  buildShellCommand,
  buildAppleScript,
  posixQuote,
  resolveTerminal,
} from '../../src/server/routes/terminal.js';

describe('terminal route helpers', () => {
  describe('posixQuote', () => {
    it('wraps plain paths in single quotes', () => {
      assert.equal(posixQuote('/Users/foo/project'), `'/Users/foo/project'`);
    });

    it('preserves spaces without escaping', () => {
      assert.equal(posixQuote('/Users/foo/My Project'), `'/Users/foo/My Project'`);
    });

    it(`escapes embedded single quotes`, () => {
      assert.equal(posixQuote(`/tmp/it's`), `'/tmp/it'\\''s'`);
    });

    it('neutralizes shell metacharacters inside quotes', () => {
      assert.equal(
        posixQuote('/tmp/a; rm -rf / && echo'),
        `'/tmp/a; rm -rf / && echo'`,
      );
    });
  });

  describe('buildShellCommand', () => {
    it('produces a cd && claude --resume pattern', () => {
      const cmd = buildShellCommand('/Users/foo/proj', 'abc123');
      assert.equal(cmd, `cd '/Users/foo/proj' && claude --resume abc123`);
    });

    it('rejects session ids with shell metacharacters', () => {
      assert.throws(() => buildShellCommand('/tmp', '; rm -rf /'));
      assert.throws(() => buildShellCommand('/tmp', '../escape'));
      assert.throws(() => buildShellCommand('/tmp', 'id with space'));
      assert.throws(() => buildShellCommand('/tmp', ''));
    });

    it('accepts valid uuid-like ids', () => {
      const cmd = buildShellCommand(
        '/tmp',
        'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      );
      assert.ok(cmd.endsWith('a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
    });
  });

  describe('buildAppleScript', () => {
    it('returns Terminal.app script when app=terminal', () => {
      const s = buildAppleScript('terminal');
      assert.ok(s.includes('application "Terminal"'));
      assert.ok(s.includes('do script (item 1 of argv)'));
    });

    it('returns iTerm2 script when app=iterm2', () => {
      const s = buildAppleScript('iterm2');
      assert.ok(s.includes('application "iTerm"'));
      assert.ok(s.includes('write text (item 1 of argv)'));
    });
  });

  describe('resolveTerminal', () => {
    it('honors explicit iterm2 preference', () => {
      assert.equal(
        resolveTerminal({
          pref: 'iterm2',
          env: { TERM_PROGRAM: 'Apple_Terminal' },
          isItermInstalled: () => false,
        }),
        'iterm2',
      );
    });

    it('honors explicit terminal preference', () => {
      assert.equal(
        resolveTerminal({
          pref: 'terminal',
          env: { TERM_PROGRAM: 'iTerm.app' },
          isItermInstalled: () => true,
        }),
        'terminal',
      );
    });

    it('auto: uses TERM_PROGRAM=iTerm.app signal', () => {
      assert.equal(
        resolveTerminal({
          pref: 'auto',
          env: { TERM_PROGRAM: 'iTerm.app' },
          isItermInstalled: () => false,
        }),
        'iterm2',
      );
    });

    it('auto: uses TERM_PROGRAM=Apple_Terminal signal', () => {
      assert.equal(
        resolveTerminal({
          pref: 'auto',
          env: { TERM_PROGRAM: 'Apple_Terminal' },
          isItermInstalled: () => true,
        }),
        'terminal',
      );
    });

    it('auto: falls back to iterm2 when installed and no env hint', () => {
      assert.equal(
        resolveTerminal({
          pref: 'auto',
          env: {},
          isItermInstalled: () => true,
        }),
        'iterm2',
      );
    });

    it('auto: defaults to Terminal.app when nothing else matches', () => {
      assert.equal(
        resolveTerminal({
          pref: 'auto',
          env: {},
          isItermInstalled: () => false,
        }),
        'terminal',
      );
    });
  });
});

describe('POST /api/sessions/:id/open-terminal', () => {
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'terminal-test-'));
    const dbPath = join(tmpDir, 'test.sqlite');
    getDb(dbPath);
    app = createApp();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDb();
    db.exec('DELETE FROM events; DELETE FROM agent_relationships; DELETE FROM sessions;');
  });

  function insertSession(id: string, projectPath: string): void {
    const db = getDb();
    db.prepare(`
      INSERT INTO sessions (id, project_path, status, started_at,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_write_tokens, compaction_count, tool_call_count, subagent_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectPath, 'completed', '2026-01-15T10:00:00Z', 100, 50, 0, 0, 0, 0, 0);
  }

  it('returns 400 on non-darwin platforms', async () => {
    if (process.platform === 'darwin') {
      // Can't easily stub process.platform here without monkey-patching; skip.
      return;
    }
    insertSession('sess-1', '/tmp/proj');
    const res = await app.request('/api/sessions/sess-1/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'auto' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'unsupported_platform');
    assert.ok(body.message.toLowerCase().includes('macos'));
  });

  it('rejects invalid session id format', async () => {
    const res = await app.request('/api/sessions/..%2Fevil/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'invalid_session_id');
  });

  it('returns 404 for nonexistent session (when platform is darwin)', async () => {
    if (process.platform !== 'darwin') return;
    const res = await app.request('/api/sessions/does-not-exist/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'auto' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'not_found');
  });

  it('returns 400 when session has no project_path (darwin)', async () => {
    if (process.platform !== 'darwin') return;
    insertSession('sess-empty', '');
    const res = await app.request('/api/sessions/sess-empty/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'auto' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'no_project_path');
  });
});
