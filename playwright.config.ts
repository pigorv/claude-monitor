import { defineConfig } from '@playwright/test';
import { BASE_URL, DIST_CLI, PORT, SERVER_ENV } from './test/e2e/helpers/paths.js';

export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  reporter: [['line']],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: BASE_URL,
  },
  webServer: {
    command: `node ${DIST_CLI} start --port ${PORT} --no-open`,
    url: `${BASE_URL}/api/health`,
    env: SERVER_ENV,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
