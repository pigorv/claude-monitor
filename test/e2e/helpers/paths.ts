import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// test/e2e/helpers/paths.ts → repo root is three levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Root temp directory for a single E2E run; wiped + recreated on each seed. */
export const E2E_TMP = join(os.tmpdir(), 'claude-monitor-e2e');

/** Isolated SQLite DB the harness reads/writes (never the developer's real DB). */
export const DB_PATH = join(E2E_TMP, 'data.sqlite');

/** Empty projects dir so the transcript watcher finds nothing on startup. */
export const PROJECTS_DIR = join(E2E_TMP, 'projects');

/** Test port, distinct from dev (4173) and demo (4175). */
export const PORT = 4176;

/** Base URL the Playwright harness drives. */
export const BASE_URL = 'http://localhost:4176';

/** Built CLI entrypoint. */
export const DIST_CLI = join(repoRoot, 'dist', 'index.js');

/** Built frontend entrypoint. */
export const DIST_FRONTEND = join(repoRoot, 'dist', 'frontend', 'index.html');

/** Golden fixture corpus the harness seeds from (a parent session + agent transcript). */
export const HAPPY_CORPUS = join(repoRoot, 'test', 'fixtures', 'happy');

/** Workspace-reset script run as the first step of the webServer command. */
export const PREPARE_SCRIPT = join(repoRoot, 'test', 'e2e', 'prepare-workspace.mjs');

/**
 * Env overrides that point the built CLI at the isolated temp locations.
 * loadConfig() (src/shared/constants.ts) resolves these ahead of the
 * HOME-based defaults, so the harness never touches real data.
 */
export const SERVER_ENV = {
  CLAUDE_MONITOR_DB_PATH: DB_PATH,
  CLAUDE_MONITOR_PROJECTS_PATH: PROJECTS_DIR,
  CLAUDE_MONITOR_PORT: String(PORT),
  HOME: E2E_TMP,
};
