import { Hono } from 'hono';
import { spawn, spawnSync } from 'node:child_process';
import { getSession } from '../../db/queries/sessions.js';
import * as logger from '../../shared/logger.js';

export type TerminalApp = 'terminal' | 'iterm2';
export type TerminalPreference = 'auto' | TerminalApp;

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

// POSIX single-quote escaping: wrap in '…', replace embedded ' with '\''
export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(projectPath: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  return `cd ${posixQuote(projectPath)} && claude --resume ${sessionId}`;
}

const TERMINAL_APPLESCRIPT = `on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run`;

const ITERM_APPLESCRIPT = `on run argv
  tell application "iTerm"
    activate
    create window with default profile
    tell current session of current window to write text (item 1 of argv)
  end tell
end run`;

export function buildAppleScript(app: TerminalApp): string {
  return app === 'iterm2' ? ITERM_APPLESCRIPT : TERMINAL_APPLESCRIPT;
}

export interface ResolveTerminalInput {
  pref: TerminalPreference;
  env: NodeJS.ProcessEnv;
  isItermInstalled: () => boolean;
}

export function resolveTerminal(input: ResolveTerminalInput): TerminalApp {
  if (input.pref === 'iterm2' || input.pref === 'terminal') {
    return input.pref;
  }
  const tp = input.env.TERM_PROGRAM;
  if (tp === 'iTerm.app') return 'iterm2';
  if (tp === 'Apple_Terminal') return 'terminal';
  if (input.isItermInstalled()) return 'iterm2';
  return 'terminal';
}

function probeItermInstalled(): boolean {
  try {
    const res = spawnSync('osascript', ['-e', 'id of application "iTerm"'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function parseTerminalPreference(value: unknown): TerminalPreference {
  if (value === 'iterm2' || value === 'terminal' || value === 'auto') return value;
  return 'auto';
}

export interface RunOsascriptResult {
  code: number;
  stderr: string;
}

function runOsascript(script: string, arg: string): Promise<RunOsascriptResult> {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-', arg], { shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ code: -1, stderr: stderr || String(err) });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stderr });
    });
    child.stdin.write(script);
    child.stdin.end();
  });
}

const terminal = new Hono();

terminal.post('/api/sessions/:id/open-terminal', async (c) => {
  if (process.platform !== 'darwin') {
    return c.json(
      {
        error: 'unsupported_platform',
        message: 'Opening a terminal is currently only supported on macOS.',
      },
      400,
    );
  }

  const id = c.req.param('id');
  if (!SESSION_ID_RE.test(id)) {
    return c.json({ error: 'invalid_session_id', message: 'Invalid session id.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const pref = parseTerminalPreference((body as { terminal?: unknown }).terminal);

  const session = getSession(id);
  if (!session) {
    return c.json({ error: 'not_found', message: 'Session not found.' }, 404);
  }
  const projectPath = session.project_path?.trim();
  if (!projectPath) {
    return c.json(
      {
        error: 'no_project_path',
        message: 'This session has no recorded project directory.',
      },
      400,
    );
  }

  const chosen = resolveTerminal({
    pref,
    env: process.env,
    isItermInstalled: probeItermInstalled,
  });

  const shellCmd = buildShellCommand(projectPath, id);
  const script = buildAppleScript(chosen);

  const result = await runOsascript(script, shellCmd);
  if (result.code !== 0) {
    logger.error('Failed to open terminal', {
      session_id: id,
      terminal: chosen,
      stderr: result.stderr,
    });
    return c.json(
      {
        error: 'osascript_failed',
        message: result.stderr.trim() || 'osascript exited with a nonzero status.',
      },
      500,
    );
  }

  return c.json({ success: true, terminal: chosen });
});

export { terminal };
