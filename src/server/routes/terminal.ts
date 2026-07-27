import { Hono } from 'hono';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getSession } from '../../db/queries/sessions.js';
import * as logger from '../../shared/logger.js';

export type DarwinTerminalApp = 'terminal' | 'iterm2';
export type Win32TerminalApp = 'wt' | 'powershell' | 'cmd';
export type TerminalApp = DarwinTerminalApp | Win32TerminalApp;
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

export function buildAppleScript(app: DarwinTerminalApp): string {
  return app === 'iterm2' ? ITERM_APPLESCRIPT : TERMINAL_APPLESCRIPT;
}

// macOS Automation gate: osascript returns -1743 (errAEEventNotPermitted)
// when the process isn't allowed to send Apple events to the terminal app.
// Match the parenthesized code osascript actually emits — e.g. "(-1743)" — so a
// stray "-1743" in an echoed path or a longer code like -17430 can't false-match.
export function isApplePermissionError(stderr: string): boolean {
  return stderr.includes('(-1743)');
}

// Friendly app name for messages (the AppleScript targets "iTerm" / "Terminal").
function darwinAppLabel(app: DarwinTerminalApp): string {
  return app === 'iterm2' ? 'iTerm' : 'Terminal';
}

export interface ResolveDarwinInput {
  pref: TerminalPreference;
  env: NodeJS.ProcessEnv;
  isItermInstalled: () => boolean;
}

export function resolveDarwinTerminal(input: ResolveDarwinInput): DarwinTerminalApp {
  if (input.pref === 'iterm2' || input.pref === 'terminal') {
    return input.pref;
  }
  const tp = input.env.TERM_PROGRAM;
  if (tp === 'iTerm.app') return 'iterm2';
  if (tp === 'Apple_Terminal') return 'terminal';
  if (input.isItermInstalled()) return 'iterm2';
  return 'terminal';
}

export interface ResolveWin32Input {
  pref: TerminalPreference;
  env: NodeJS.ProcessEnv;
  isWtInstalled: () => boolean;
}

export function resolveWin32Terminal(input: ResolveWin32Input): Win32TerminalApp {
  if (input.pref === 'wt' || input.pref === 'powershell' || input.pref === 'cmd') {
    return input.pref;
  }
  // Darwin-only prefs fall through to auto on win32.
  if (input.env.WT_SESSION) return 'wt';
  if (input.isWtInstalled()) return 'wt';
  if (input.env.PSModulePath) return 'powershell';
  return 'cmd';
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

function probeWtInstalled(): boolean {
  try {
    const res = spawnSync('where.exe', ['wt.exe'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function parseTerminalPreference(value: unknown): TerminalPreference {
  if (
    value === 'auto' ||
    value === 'terminal' ||
    value === 'iterm2' ||
    value === 'wt' ||
    value === 'powershell' ||
    value === 'cmd'
  ) {
    return value;
  }
  return 'auto';
}

// PowerShell single-quoted string: wrap in '…', double any embedded '.
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`;
}

// cmd.exe has no general escape mechanism inside "…" strings. We wrap the path
// in double quotes and refuse the (rare) characters that would let the path
// break out of the quoted context or trigger delayed-expansion / variable
// expansion. Backslash-escaping would not work — cmd doesn't honour it.
function cmdQuote(value: string): string {
  if (/["%!\r\n]/.test(value)) {
    throw new Error('Unsupported character in project path for cmd.exe');
  }
  return `"${value}"`;
}

// wt.exe re-tokenizes its own command line and treats ';' as a subcommand
// separator, so a path containing ';' (a legal Windows directory char) would
// inject a second wt subcommand. Reject it rather than try to escape — wt has
// no documented escape for ';' in a -d argument. '"' can't occur in a real
// Windows path (reserved char) but is rejected defensively, as are control
// chars that could split the command line.
function assertWtSafePath(value: string): void {
  if (/[;"\r\n]/.test(value)) {
    throw new Error('Unsupported character in project path for Windows Terminal');
  }
}

export interface WindowsLaunchSpec {
  exe: string;
  args: string[];
}

export function buildWindowsLaunch(
  app: Win32TerminalApp,
  projectPath: string,
  sessionId: string,
): WindowsLaunchSpec {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error('Invalid session id');
  }
  const resume = `claude --resume ${sessionId}`;
  switch (app) {
    case 'wt':
      // -d takes the cwd as its own argv element; only the resume command
      // reaches PowerShell, and sessionId is already char-restricted. wt still
      // re-tokenizes its command line, so the path is guarded against ';'.
      assertWtSafePath(projectPath);
      return {
        exe: 'wt.exe',
        args: ['-d', projectPath, 'powershell.exe', '-NoExit', '-Command', resume],
      };
    case 'powershell':
      // -LiteralPath neutralises [ ] * wildcards in the path. The whole
      // -Command string is one argv element so cmd.exe quoting rules
      // don't apply.
      return {
        exe: 'powershell.exe',
        args: [
          '-NoExit',
          '-Command',
          `Set-Location -LiteralPath ${psSingleQuote(projectPath)}; ${resume}`,
        ],
      };
    case 'cmd':
      return {
        exe: 'cmd.exe',
        args: ['/D', '/K', `cd /d ${cmdQuote(projectPath)} && ${resume}`],
      };
  }
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

// Fire-and-forget launch: the terminal process is long-lived (it stays open
// until the user quits it), so we resolve as soon as the OS confirms the
// spawn, not when the child closes. A `'spawn'` event covers ENOENT / PATH
// failures, which is the only failure mode worth surfacing here.
function launchWindows(spec: WindowsLaunchSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.exe, spec.args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    });
  });
}

const terminal = new Hono();

terminal.post('/api/sessions/:id/open-terminal', async (c) => {
  // Request-shape checks first (apply regardless of platform) so callers
  // get accurate errors instead of having a bad id masked by a platform
  // error.
  const id = c.req.param('id');
  if (!SESSION_ID_RE.test(id)) {
    return c.json({ error: 'invalid_session_id', message: 'Invalid session id.' }, 400);
  }

  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return c.json(
      {
        error: 'unsupported_platform',
        message: 'Opening a terminal is currently only supported on macOS and Windows.',
      },
      400,
    );
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

  if (!session.transcript_path || !existsSync(session.transcript_path)) {
    return c.json(
      {
        error: 'transcript_deleted',
        message:
          "This session's transcript was deleted by Claude Code's retention cleanup, so it can't be resumed.",
      },
      410,
    );
  }

  if (process.platform === 'darwin') {
    const chosen = resolveDarwinTerminal({
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
      if (isApplePermissionError(result.stderr)) {
        const label = darwinAppLabel(chosen);
        return c.json(
          {
            error: 'terminal_permission_denied',
            message: `macOS blocked claude-monitor from controlling ${label}. Open System Settings → Privacy & Security → Automation, enable ${label} under the app running claude-monitor (your terminal or Node), then try again.`,
          },
          403,
        );
      }
      return c.json(
        {
          error: 'osascript_failed',
          message: result.stderr.trim() || 'osascript exited with a nonzero status.',
        },
        500,
      );
    }

    return c.json({ success: true, terminal: chosen });
  }

  // win32
  const chosen = resolveWin32Terminal({
    pref,
    env: process.env,
    isWtInstalled: probeWtInstalled,
  });

  let spec: WindowsLaunchSpec;
  try {
    spec = buildWindowsLaunch(chosen, projectPath, id);
  } catch (err) {
    return c.json(
      {
        error: 'invalid_project_path',
        message: err instanceof Error ? err.message : 'Failed to build launch command.',
      },
      500,
    );
  }

  try {
    await launchWindows(spec);
  } catch (err) {
    logger.error('Failed to open terminal', {
      session_id: id,
      terminal: chosen,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json(
      {
        error: 'spawn_failed',
        message: err instanceof Error ? err.message : 'Failed to spawn terminal.',
      },
      500,
    );
  }

  return c.json({ success: true, terminal: chosen });
});

export { terminal };
