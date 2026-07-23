import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { DIST_CLI, E2E_TMP, PROJECTS_DIR, SERVER_ENV } from './paths.js';

/**
 * Reset the isolated temp locations and seed the E2E database by running the
 * built importer exactly as a user would (`node dist/index.js import <dir>`).
 *
 * The `import` subprocess opens the DB at CLAUDE_MONITOR_DB_PATH, which runs
 * migrations on first open, then imports every *.jsonl under `corpusDir`.
 */
export function seedCorpus(corpusDir: string): void {
  rmSync(E2E_TMP, { recursive: true, force: true });
  // Creating PROJECTS_DIR recursively also creates E2E_TMP.
  mkdirSync(PROJECTS_DIR, { recursive: true });

  execFileSync('node', [DIST_CLI, 'import', corpusDir], {
    env: { ...process.env, ...SERVER_ENV },
    stdio: 'inherit',
  });
}
