import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HELP = `Usage: claude-monitor setup [options]

Configure Claude Code hooks to send events to claude-monitor.

Options:
  --dry-run     Show what would be written without modifying files
  --help, -h    Show this help message`;

// ── Hook types and their event names ────────────────────────────────

const HOOK_EVENTS: Array<{ hookType: string; eventName: string }> = [
  { hookType: 'PreToolUse', eventName: 'pre_tool_use' },
  { hookType: 'PostToolUse', eventName: 'post_tool_use' },
  { hookType: 'SubagentStart', eventName: 'subagent_start' },
  { hookType: 'SubagentStop', eventName: 'subagent_stop' },
  { hookType: 'PreCompact', eventName: 'pre_compact' },
  { hookType: 'SessionStart', eventName: 'session_start' },
  { hookType: 'SessionEnd', eventName: 'session_end' },
];

// ── Resolve capture script path ─────────────────────────────────────

function resolveCaptureScriptPath(): string {
  // Try relative to this file first (works in dev and built)
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(thisFile), '..', '..', '..');
  const capturePath = join(projectRoot, 'hooks', 'capture.mjs');
  if (existsSync(capturePath)) return capturePath;

  // Fallback: try from cwd
  const cwdPath = join(process.cwd(), 'hooks', 'capture.mjs');
  if (existsSync(cwdPath)) return cwdPath;

  throw new Error(
    `Could not find hooks/capture.mjs. Looked in:\n  ${capturePath}\n  ${cwdPath}`,
  );
}

// ── Build hook config ───────────────────────────────────────────────

interface HookEntry {
  type: 'command';
  command: string;
  async: true;
  timeout: number;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

function buildHookConfig(captureScriptPath: string): Record<string, HookMatcher[]> {
  const hooks: Record<string, HookMatcher[]> = {};

  for (const { hookType, eventName } of HOOK_EVENTS) {
    hooks[hookType] = [
      {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `node ${captureScriptPath} ${eventName}`,
            async: true,
            timeout: 10,
          },
        ],
      },
    ];
  }

  return hooks;
}

// ── Merge hooks into existing settings ──────────────────────────────

function mergeHooks(
  existing: Record<string, unknown>,
  newHooks: Record<string, HookMatcher[]>,
): Record<string, unknown> {
  const result = { ...existing };
  const existingHooks = (result.hooks ?? {}) as Record<string, HookMatcher[]>;
  const mergedHooks = { ...existingHooks };

  for (const [hookType, matchers] of Object.entries(newHooks)) {
    const existingMatchers = mergedHooks[hookType] ?? [];

    // Check if there's already a claude-monitor hook for this type
    const hasMonitorHook = existingMatchers.some((m) =>
      m.hooks?.some((h) => h.command?.includes('capture.mjs')),
    );

    if (hasMonitorHook) {
      // Replace the existing claude-monitor hook entry
      mergedHooks[hookType] = existingMatchers.map((m) => {
        const hasCapture = m.hooks?.some((h) =>
          h.command?.includes('capture.mjs'),
        );
        return hasCapture ? matchers[0] : m;
      });
    } else {
      // Append our hook matcher
      mergedHooks[hookType] = [...existingMatchers, ...matchers];
    }
  }

  result.hooks = mergedHooks;
  return result;
}

// ── Main command ────────────────────────────────────────────────────

export async function setupCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const settingsPath = join(homedir(), '.claude', 'settings.local.json');

  // Resolve capture script
  let captureScriptPath: string;
  try {
    captureScriptPath = resolveCaptureScriptPath();
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // Build hook configuration
  const newHooks = buildHookConfig(captureScriptPath);

  // Read existing settings (if any)
  let existingSettings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const content = readFileSync(settingsPath, 'utf-8');
      existingSettings = JSON.parse(content);
    } catch (err) {
      console.error(
        `Warning: Could not parse existing ${settingsPath}, will create a backup and start fresh.`,
      );
      existingSettings = {};
    }
  }

  // Merge
  const merged = mergeHooks(existingSettings, newHooks);

  if (dryRun) {
    console.log('Dry run — would write to:', settingsPath);
    console.log(JSON.stringify(merged, null, 2));
    return;
  }

  // Backup existing file
  if (existsSync(settingsPath)) {
    const backupPath = settingsPath + '.backup';
    copyFileSync(settingsPath, backupPath);
    console.log(`Backed up existing settings to ${backupPath}`);
  }

  // Write merged settings
  const claudeDir = dirname(settingsPath);
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');

  console.log(`Hooks configured in ${settingsPath}`);
  console.log(`Capture script: ${captureScriptPath}`);
  console.log(`Hook types: ${HOOK_EVENTS.map((h) => h.hookType).join(', ')}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Restart Claude Code (or start a new session)');
  console.log('  2. Run "claude-monitor start" to launch the dashboard');
  console.log('  3. Use "/hooks" in Claude Code to verify hooks are active');
}
