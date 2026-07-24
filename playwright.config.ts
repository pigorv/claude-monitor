import { defineConfig } from '@playwright/test';
import {
  BASE_URL,
  DIST_CLI,
  HAPPY_CORPUS,
  PLAN_IMPL_CORPUS,
  PORT,
  PREPARE_SCRIPT,
  SERVER_ENV,
} from './test/e2e/helpers/paths.js';

// Playwright starts `webServer` BEFORE `globalSetup`, so the DB must be seeded
// inside the server command itself — seeding from globalSetup would race the
// already-running server (and wipe the file it holds open). The command resets
// the isolated temp dir, imports the golden corpus into the temp DB, then boots
// the real server; Playwright only considers it ready once `/api/health` responds,
// which is after the import has finished.
const q = (s: string) => JSON.stringify(s);
const reset = `node ${q(PREPARE_SCRIPT)}`;
const seed = `node ${q(DIST_CLI)} import ${q(HAPPY_CORPUS)} && node ${q(DIST_CLI)} import ${q(PLAN_IMPL_CORPUS)}`;
const serve = `node ${q(DIST_CLI)} start --port ${PORT} --no-open`;

export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  workers: 1,
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  reporter: [['line']],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: `${reset} && ${seed} && ${serve}`,
    url: `${BASE_URL}/api/health`,
    env: SERVER_ENV,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
