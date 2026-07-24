import { existsSync } from 'node:fs';
import { DIST_CLI, DIST_FRONTEND } from './helpers/paths.js';

/**
 * Playwright global setup: assert the build outputs exist (the harness never
 * builds anything itself). Seeding is done inside the `webServer` command in
 * playwright.config.ts, because Playwright starts the web server before this
 * hook — seeding here would race the already-running server.
 */
export default async function globalSetup(): Promise<void> {
  for (const path of [DIST_CLI, DIST_FRONTEND]) {
    if (!existsSync(path)) {
      throw new Error(
        `E2E harness needs a build — run \`npm run build\` first (missing ${path}).`,
      );
    }
  }
}
