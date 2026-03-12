import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG, VERSION } from '../../shared/constants.js';
import { getDb, closeDb } from '../../db/connection.js';

const USAGE = `Usage: claude-monitor status

  Show current hook configuration, database stats, and server status.`;

interface StatusInfo {
  version: string;
  hooks: { configured: boolean; details: string };
  database: { path: string; exists: boolean; sizeBytes: number; sessionCount: number; eventCount: number };
  server: { running: boolean; port: number };
}

function checkHooks(): { configured: boolean; details: string } {
  const settingsPath = join(homedir(), '.claude', 'settings.local.json');
  if (!existsSync(settingsPath)) {
    return { configured: false, details: 'No settings.local.json found — run "claude-monitor setup" to configure hooks' };
  }
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    if (content.includes('claude-monitor')) {
      return { configured: true, details: 'Hooks detected in ~/.claude/settings.local.json' };
    }
    return { configured: false, details: 'settings.local.json exists but no claude-monitor hooks found' };
  } catch {
    return { configured: false, details: 'Could not read settings.local.json' };
  }
}

function checkDatabase(dbPath: string): { path: string; exists: boolean; sizeBytes: number; sessionCount: number; eventCount: number } {
  if (!existsSync(dbPath)) {
    return { path: dbPath, exists: false, sizeBytes: 0, sessionCount: 0, eventCount: 0 };
  }

  try {
    const db = getDb(dbPath);
    const sizeBytes = statSync(dbPath).size;
    const sessionRow = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as { count: number };
    const eventRow = db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number };
    closeDb();

    return { path: dbPath, exists: true, sizeBytes, sessionCount: sessionRow.count, eventCount: eventRow.count };
  } catch {
    return { path: dbPath, exists: true, sizeBytes: 0, sessionCount: 0, eventCount: 0 };
  }
}

async function checkServer(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export async function statusCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const port = DEFAULT_CONFIG.defaultPort;
  const dbPath = DEFAULT_CONFIG.dbPath;

  const hooks = checkHooks();
  const database = checkDatabase(dbPath);
  const serverRunning = await checkServer(port);

  const status: StatusInfo = {
    version: VERSION,
    hooks,
    database,
    server: { running: serverRunning, port },
  };

  console.log(`claude-monitor v${status.version}\n`);

  // Hooks
  console.log(`Hooks: ${status.hooks.configured ? 'configured' : 'not configured'}`);
  console.log(`  ${status.hooks.details}\n`);

  // Database
  console.log(`Database: ${status.database.exists ? 'exists' : 'not found'}`);
  console.log(`  Path:     ${status.database.path}`);
  if (status.database.exists) {
    console.log(`  Size:     ${formatBytes(status.database.sizeBytes)}`);
    console.log(`  Sessions: ${status.database.sessionCount}`);
    console.log(`  Events:   ${status.database.eventCount}`);
  }
  console.log();

  // Server
  console.log(`Server: ${status.server.running ? 'running' : 'not running'}`);
  console.log(`  Port: ${status.server.port}`);
  if (status.server.running) {
    console.log(`  URL:  http://localhost:${status.server.port}`);
  }
}
