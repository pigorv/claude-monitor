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
  buildWindowsLaunch,
  posixQuote,
  resolveDarwinTerminal,
  resolveWin32Terminal,
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

  describe('resolveDarwinTerminal', () => {
    it('honors explicit iterm2 preference', () => {
      assert.equal(
        resolveDarwinTerminal({
          pref: 'iterm2',
          env: { TERM_PROGRAM: 'Apple_Terminal' },
          isItermInstalled: () => false,
        }),
        'iterm2',
      );
    });

    it('honors explicit terminal preference', () => {
      assert.equal(
        resolveDarwinTerminal({
          pref: 'terminal',
          env: { TERM_PROGRAM: 'iTerm.app' },
          isItermInstalled: () => true,
        }),
        'terminal',
      );
    });

    it('auto: uses TERM_PROGRAM=iTerm.app signal', () => {
      assert.equal(
        resolveDarwinTerminal({
          pref: 'auto',
          env: { TERM_PROGRAM: 'iTerm.app' },
          isItermInstalled: () => false,
        }),
        'iterm2',
      );
    });

    it('auto: uses TERM_PROGRAM=Apple_Terminal signal', () => {
      assert.equal(
        resolveDarwinTerminal({
          pref: 'auto',
          env: { TERM_PROGRAM: 'Apple_Terminal' },
          isItermInstalled: () => true,
        }),
        'terminal',
      );
    });

    it('auto: falls back to iterm2 when installed and no env hint', () => {
      assert.equal(
        resolveDarwinTerminal({
          pref: 'auto',
          env: {},
          isItermInstalled: () => true,
        }),
        'iterm2',
      );
    });

    it('auto: defaults to Terminal.app when nothing else matches', () => {
      assert.equal(
        resolveDarwinTerminal({
          pref: 'auto',
          env: {},
          isItermInstalled: () => false,
        }),
        'terminal',
      );
    });

    it('falls through to auto when given a win32-only pref', () => {
      assert.equal(
        resolveDarwinTerminal({
          pref: 'wt',
          env: {},
          isItermInstalled: () => true,
        }),
        'iterm2',
      );
    });
  });

  describe('resolveWin32Terminal', () => {
    it('honors explicit wt preference', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'wt',
          env: {},
          isWtInstalled: () => false,
        }),
        'wt',
      );
    });

    it('honors explicit powershell preference', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'powershell',
          env: { WT_SESSION: 'abc' },
          isWtInstalled: () => true,
        }),
        'powershell',
      );
    });

    it('honors explicit cmd preference', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'cmd',
          env: { WT_SESSION: 'abc' },
          isWtInstalled: () => true,
        }),
        'cmd',
      );
    });

    it('auto: uses WT_SESSION env signal', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'auto',
          env: { WT_SESSION: 'abc' },
          isWtInstalled: () => false,
        }),
        'wt',
      );
    });

    it('auto: picks wt when installed and no env hint', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'auto',
          env: { PSModulePath: 'C:\\foo' },
          isWtInstalled: () => true,
        }),
        'wt',
      );
    });

    it('auto: falls back to powershell when wt not installed', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'auto',
          env: { PSModulePath: 'C:\\foo' },
          isWtInstalled: () => false,
        }),
        'powershell',
      );
    });

    it('auto: defaults to cmd when nothing else matches', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'auto',
          env: {},
          isWtInstalled: () => false,
        }),
        'cmd',
      );
    });

    it('falls through to auto when given a darwin-only pref', () => {
      assert.equal(
        resolveWin32Terminal({
          pref: 'iterm2',
          env: {},
          isWtInstalled: () => true,
        }),
        'wt',
      );
    });
  });

  describe('buildWindowsLaunch', () => {
    it('builds wt.exe argv with path via -d (no shell parsing)', () => {
      const spec = buildWindowsLaunch('wt', 'C:\\Users\\Test User\\repo', 'abc123');
      assert.equal(spec.exe, 'wt.exe');
      assert.deepEqual(spec.args, [
        '-d',
        'C:\\Users\\Test User\\repo',
        'powershell.exe',
        '-NoExit',
        '-Command',
        'claude --resume abc123',
      ]);
    });

    it('builds powershell argv with single-quoted -LiteralPath', () => {
      const spec = buildWindowsLaunch('powershell', "C:\\dev\\it's mine", 'abc-123');
      assert.equal(spec.exe, 'powershell.exe');
      assert.deepEqual(spec.args, [
        '-NoExit',
        '-Command',
        `Set-Location -LiteralPath 'C:\\dev\\it''s mine'; claude --resume abc-123`,
      ]);
    });

    it('builds cmd.exe argv with quoted cd /d and resume command', () => {
      const spec = buildWindowsLaunch('cmd', 'C:\\Users\\proj', 'abc_123');
      assert.equal(spec.exe, 'cmd.exe');
      assert.deepEqual(spec.args, [
        '/D',
        '/K',
        `cd /d "C:\\Users\\proj" && claude --resume abc_123`,
      ]);
    });

    it('rejects cmd paths containing a double quote', () => {
      assert.throws(
        () => buildWindowsLaunch('cmd', 'C:\\bad"path', 'abc'),
        /Unsupported character in project path for cmd\.exe/,
      );
    });

    it('rejects cmd paths containing % or ! or newlines', () => {
      const re = /Unsupported character in project path for cmd\.exe/;
      assert.throws(() => buildWindowsLaunch('cmd', 'C:\\%PATH%', 'abc'), re);
      assert.throws(() => buildWindowsLaunch('cmd', 'C:\\bang!', 'abc'), re);
      assert.throws(() => buildWindowsLaunch('cmd', 'C:\\new\nline', 'abc'), re);
    });

    it('rejects wt paths containing a semicolon (wt subcommand separator)', () => {
      assert.throws(
        () => buildWindowsLaunch('wt', 'C:\\a;calc', 'abc'),
        /Unsupported character in project path for Windows Terminal/,
      );
    });

    it('powershell accepts a semicolon in the path (safe inside -LiteralPath)', () => {
      const spec = buildWindowsLaunch('powershell', 'C:\\a;b', 'abc');
      assert.equal(spec.exe, 'powershell.exe');
      assert.deepEqual(spec.args, [
        '-NoExit',
        '-Command',
        `Set-Location -LiteralPath 'C:\\a;b'; claude --resume abc`,
      ]);
    });

    it('rejects session ids with shell metacharacters', () => {
      assert.throws(
        () => buildWindowsLaunch('wt', 'C:\\proj', '; rm -rf /'),
        /Invalid session id/,
      );
      assert.throws(
        () => buildWindowsLaunch('powershell', 'C:\\proj', 'id with space'),
        /Invalid session id/,
      );
      assert.throws(() => buildWindowsLaunch('cmd', 'C:\\proj', ''), /Invalid session id/);
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

  it('returns 400 on unsupported platforms (e.g. linux)', async () => {
    if (process.platform === 'darwin' || process.platform === 'win32') {
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
    assert.ok(body.message.toLowerCase().includes('windows'));
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

  it('returns 404 for nonexistent session (on supported platforms)', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    const res = await app.request('/api/sessions/does-not-exist/open-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: 'auto' }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'not_found');
  });

  it('returns 400 when session has no project_path (on supported platforms)', async () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
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
