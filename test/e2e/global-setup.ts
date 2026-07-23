import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIST_CLI, DIST_FRONTEND } from './helpers/paths.js';
import { seedCorpus } from './helpers/seed.js';

// test/e2e/global-setup.ts → repo root is two levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Playwright global setup: assert the build outputs exist (the harness never
 * builds anything itself), then seed the isolated temp DB from the golden
 * corpus before the webServer boots.
 */
export default async function globalSetup(): Promise<void> {
  for (const path of [DIST_CLI, DIST_FRONTEND]) {
    if (!existsSync(path)) {
      throw new Error(
        `E2E harness needs a build — run \`npm run build\` first (missing ${path}).`,
      );
    }
  }

  seedCorpus(join(repoRoot, 'test/fixtures/happy'));
}
