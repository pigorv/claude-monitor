import { rmSync } from 'node:fs';
import { E2E_TMP } from './helpers/paths.js';

/**
 * Playwright global teardown: remove the isolated temp data/projects dir so a
 * run leaves nothing behind. The webServer process tree is killed by Playwright
 * itself before this runs.
 */
export default async function globalTeardown(): Promise<void> {
  rmSync(E2E_TMP, { recursive: true, force: true });
}
