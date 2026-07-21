import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EventType } from './types.js';

// Re-export MODEL_THRESHOLDS from the browser-safe module so existing
// backend imports (`from '../shared/constants.js'`) keep working.
export { MODEL_THRESHOLDS, SONNET_1M_THRESHOLDS } from './model-thresholds.js';

// Injected at build time by tsup (see tsup.config.ts `define`)
export const VERSION = process.env.APP_VERSION ?? '0.0.0-dev';

/**
 * Parse a CLAUDE_MONITOR_PORT value. Unset or empty falls back to 4173.
 * Otherwise the value must be an integer in 1..65535, or an Error is thrown.
 * Mirrors the `--port` validation in src/cli/commands/start.ts.
 */
export function parsePort(v: string | undefined): number {
  if (v === undefined || v === '') return 4173;
  const val = Number(v);
  if (!Number.isInteger(val) || val < 1 || val > 65535) {
    throw new Error(`Invalid CLAUDE_MONITOR_PORT "${v}": expected an integer 1-65535`);
  }
  return val;
}

export interface Config {
  dataDir: string;
  dbPath: string;
  defaultPort: number;
  host: string | undefined;
  claudeProjectsPath: string;
}

/**
 * Pure config loader. Resolves all 5 env vars from the passed `env`, each
 * falling back to today's default when unset. Relative path values resolve
 * against process.cwd(). Throws on an invalid CLAUDE_MONITOR_PORT.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Readonly<Config> {
  const resolvePath = (v: string | undefined, fallback: string) => (v ? resolve(v) : fallback);
  const dataDir = resolvePath(env.CLAUDE_MONITOR_DATA_DIR, join(homedir(), '.claude-monitor'));
  return Object.freeze({
    dataDir,
    dbPath: resolvePath(env.CLAUDE_MONITOR_DB_PATH, join(dataDir, 'data.sqlite')),
    defaultPort: parsePort(env.CLAUDE_MONITOR_PORT),
    host: env.CLAUDE_MONITOR_HOST,
    claudeProjectsPath: resolvePath(
      env.CLAUDE_MONITOR_PROJECTS_PATH,
      join(homedir(), '.claude', 'projects'),
    ),
  });
}

export const CONFIG = loadConfig();

/** @deprecated use CONFIG — kept one release for external importers */
export const DEFAULT_CONFIG = CONFIG;

export const EVENT_TYPES: readonly EventType[] = [
  'session_start',
  'session_end',
  'tool_call_start',
  'tool_call_end',
  'subagent_start',
  'subagent_end',
  'compaction',
  'thinking',
  'assistant_message',
  'user_message',
  'notification',
] as const;

export const PREVIEW_LIMITS = Object.freeze({
  inputPreview: 500,
  outputPreview: 500,
  thinkingSummary: 200,
});
