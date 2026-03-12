import { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { VERSION, DEFAULT_CONFIG } from '../../shared/constants.js';
import { getDbStats } from '../../db/queries/stats.js';
import { getDbPath } from '../../db/connection.js';
import type { HookStatus } from '../../shared/types.js';

const health = new Hono();

const HOOK_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'Notification',
  'SubagentStart',
  'SubagentStop',
] as const;

function checkHooksConfigured(): boolean {
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.local.json');
    if (!existsSync(settingsPath)) return false;
    const content = readFileSync(settingsPath, 'utf-8');
    return content.includes('claude-monitor');
  } catch {
    return false;
  }
}

function getPerHookStatus(): Record<string, HookStatus> {
  const result: Record<string, HookStatus> = {};
  let settings: Record<string, unknown> = {};

  try {
    const settingsPath = join(homedir(), '.claude', 'settings.local.json');
    if (existsSync(settingsPath)) {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    }
  } catch {
    // Settings file missing or corrupt
  }

  // Check if capture.mjs exists in the hooks directory
  const hooksDir = join(homedir(), '.claude-monitor', 'hooks');
  const captureExists = existsSync(join(hooksDir, 'capture.mjs'));

  for (const hookType of HOOK_TYPES) {
    const hookKey = `hooks.${hookType}`;
    const hookConfig = settings[hookKey];
    let configured = false;
    if (hookConfig && typeof hookConfig === 'object') {
      configured = JSON.stringify(hookConfig).includes('claude-monitor');
    } else if (typeof hookConfig === 'string') {
      configured = hookConfig.includes('claude-monitor');
    }
    // Also check nested hooks object
    if (!configured && settings['hooks'] && typeof settings['hooks'] === 'object') {
      const hooks = settings['hooks'] as Record<string, unknown>;
      const hookVal = hooks[hookType];
      if (hookVal) {
        configured = JSON.stringify(hookVal).includes('claude-monitor');
      }
    }

    result[hookType] = {
      configured,
      script_exists: captureExists,
    };
  }

  return result;
}

health.get('/api/health', (c) => {
  const stats = getDbStats();
  const hooksConfigured = checkHooksConfigured();
  const hooks = getPerHookStatus();
  return c.json({
    status: 'ok',
    version: VERSION,
    node_version: process.version,
    db_path: getDbPath(),
    db_engine: 'better-sqlite3 (WAL)',
    server_port: Number(process.env.PORT || DEFAULT_CONFIG.defaultPort),
    db_size_bytes: stats.dbSizeBytes,
    session_count: stats.sessionCount,
    event_count: stats.eventCount,
    oldest_session: stats.oldestSession,
    newest_session: stats.newestSession,
    hooks_configured: hooksConfigured,
    hooks,
  });
});

export { health };
