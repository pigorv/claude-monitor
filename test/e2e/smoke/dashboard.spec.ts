// Smoke: the dashboard loads at `/` and renders at least one seeded session
// row (`.srow`), proving the real server served the built SPA backed by the
// seeded temp DB. baseURL is configured in playwright.config.ts.
import { test, expect } from '@playwright/test';

test('@smoke dashboard loads with seeded data', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('.srow');
  expect(await page.locator('.srow').count()).toBeGreaterThan(0);
});
