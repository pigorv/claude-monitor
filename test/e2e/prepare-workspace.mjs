// Reset the isolated E2E workspace before the server boots. Invoked as the
// first step of the `webServer` command in playwright.config.ts (seeding must
// run before the server opens the DB — Playwright starts webServer before
// globalSetup, so this can't live in a global hook). Reads the same temp paths
// the harness passes via CLAUDE_MONITOR_* env, so there is one source of truth.
import { rmSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const dbPath = process.env.CLAUDE_MONITOR_DB_PATH;
const projectsDir = process.env.CLAUDE_MONITOR_PROJECTS_PATH;

if (!dbPath || !projectsDir) {
  console.error(
    'prepare-workspace: CLAUDE_MONITOR_DB_PATH and CLAUDE_MONITOR_PROJECTS_PATH must be set',
  );
  process.exit(1);
}

// Wipe the whole temp root (parent of the DB) and recreate the empty projects
// dir; mkdir recursive also recreates the root so the importer can open the DB.
rmSync(dirname(dbPath), { recursive: true, force: true });
mkdirSync(projectsDir, { recursive: true });
