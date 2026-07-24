// E2E smoke user journeys (issue #146, T2.1). These drive the REAL built
// CLI/server (baseURL configured in playwright.config.ts) seeded at boot with
// two corpora: happy/ (sess-001 opus, hook-sess-1 sonnet) and plan-impl-pair/.
//
// Robustness rules applied throughout:
//  - Assert on the specific seeded ids below, never on exact global totals
//    (sibling mutating specs change them).
//  - Prefer auto-retrying expect() over fixed waits; the only fixed wait is the
//    search debounce in J4, which genuinely requires it.
//  - J1 mutates the DB, so it lives in its own serial describe and restores the
//    full baseline on teardown; its assertions are watcher-tolerant.
import { test, expect, type Page } from '@playwright/test';
import {
  SESS_OPUS,
  SESS_SONNET,
  clearDbViaApi,
  seedProjectsDir,
  restoreBaseline,
  selectDropdownByLabel,
} from '../helpers/journeys.js';

// Relative DOM order of two known session rows. Reads a SINGLE snapshot of all
// `a.srow` hrefs (both rows asserted visible first by the caller) so the two
// indices are always drawn from the same render — no cross-read race.
async function relativeOrder(
  page: Page,
  firstFragment: string,
  secondFragment: string,
): Promise<{ first: number; second: number }> {
  const hrefs = await page.$$eval('a.srow', (els) => els.map((e) => e.getAttribute('href') ?? ''));
  return {
    first: hrefs.findIndex((h) => h.includes(firstFragment)),
    second: hrefs.findIndex((h) => h.includes(secondFragment)),
  };
}

// ── J1 — First-run / empty state → import shows data (MUTATING) ─────────────
// Serial + single test body so the 5s transcript-watcher never races the
// clear→seed→reimport sequence: the projects dir stays empty until AFTER the
// DB is cleared and the empty state is confirmed.
test.describe('J1 first-run import', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async ({ request }) => {
    // Leave the DB holding both corpora for later specs (idempotent).
    await restoreBaseline(request);
  });

  test('@smoke first run: empty state → Re-import → data appears', async ({ page, request }) => {
    // 1. Empty the DB. Projects dir is still empty, so the watcher has nothing
    //    to re-add during this window.
    await clearDbViaApi(request);

    // 2. The list shows its empty state.
    await page.goto('/');
    await expect(page.locator('.status-text', { hasText: 'No sessions found.' })).toBeVisible();

    // 3. Now populate the projects dir so a Re-import rebuilds the baseline.
    seedProjectsDir();

    // 4. Drive Re-import through the Settings UI (the point of this journey).
    await page.goto('#/settings');
    const reimportBtn = page.getByRole('button', { name: 'Re-import' });
    await expect(reimportBtn).toBeEnabled();
    await reimportBtn.click();
    // Completion signal: the settings hint reports the import result.
    await expect(page.locator('p.settings-hint', { hasText: /Imported/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(reimportBtn).toBeEnabled();

    // 5. A known seeded row reappears (watcher-tolerant: assert end state only).
    await page.goto('/');
    await expect(page.locator(`a.srow[href*="${SESS_OPUS.id}"]`)).toBeVisible();
  });
});

// ── J2 — Open a session → tabs render (read-only) ───────────────────────────
test('@smoke J2 open session: Timeline/Context/Agents tabs render', async ({ page }) => {
  await page.goto(`#/session/${SESS_OPUS.id}`);
  await expect(page.locator('.session-detail')).toBeVisible();

  // Timeline is active by default and its content renders.
  const timelineTab = page.locator('button.tab', { hasText: 'Timeline' });
  await expect(timelineTab).toHaveClass(/active/);
  await expect(page.locator('.tab-content .timeline')).toBeVisible();

  // Context tab → active, TokenChart content renders (sess-001 has token data).
  await page.locator('button.tab', { hasText: 'Context' }).click();
  await expect(page.locator('button.tab', { hasText: 'Context' })).toHaveClass(/active/);
  await expect(page.locator('.tab-content .chart-container')).toBeVisible();

  // Agents tab → active, AgentTree content renders. Seeded sessions have NO
  // subagents, so assert the container/empty-state renders — NOT an agent count.
  await page.locator('button.tab', { hasText: 'Agents' }).click();
  await expect(page.locator('button.tab', { hasText: 'Agents' })).toHaveClass(/active/);
  await expect(
    page.locator('.tab-content .agent-tree, .tab-content .status-text'),
  ).toBeVisible();
});

// ── J3 — Filter + sort (read-only) ──────────────────────────────────────────
test('@smoke J3 filter and sort the session list', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(`a.srow[href*="${SESS_OPUS.id}"]`)).toBeVisible();

  // Sort by Oldest: sess-001 (2026-01-01) before hook-sess-1 (2026-01-15).
  // The list re-renders asynchronously after the sort (a fresh fetch clears then
  // repopulates the rows), so a single snapshot can catch a mid-render state
  // where a row is momentarily absent (index -1). Retry the whole read-and-
  // compare until the list settles into the expected order.
  await selectDropdownByLabel(page, '↓ Latest', '↑ Oldest');
  await expect(async () => {
    const hrefs = await page.$$eval('a.srow', (els) =>
      els.map((e) => e.getAttribute('href') ?? ''),
    );
    const iOpus = hrefs.findIndex((h) => h.includes(SESS_OPUS.id));
    const iSonnet = hrefs.findIndex((h) => h.includes(SESS_SONNET.id));
    expect(iOpus).toBeGreaterThanOrEqual(0);
    expect(iSonnet).toBeGreaterThanOrEqual(0);
    expect(iOpus).toBeLessThan(iSonnet); // ↑ Oldest: sess-001 before hook-sess-1
  }).toPass();

  // Sort by Latest: order flips — hook-sess-1 before sess-001.
  await selectDropdownByLabel(page, '↑ Oldest', '↓ Latest');
  await expect(async () => {
    const hrefs = await page.$$eval('a.srow', (els) =>
      els.map((e) => e.getAttribute('href') ?? ''),
    );
    const iOpus = hrefs.findIndex((h) => h.includes(SESS_OPUS.id));
    const iSonnet = hrefs.findIndex((h) => h.includes(SESS_SONNET.id));
    expect(iOpus).toBeGreaterThanOrEqual(0);
    expect(iSonnet).toBeGreaterThanOrEqual(0);
    expect(iSonnet).toBeLessThan(iOpus); // ↓ Latest: hook-sess-1 before sess-001
  }).toPass();

  // Filter by Opus: sess-001 stays, sonnet hook-sess-1 drops out.
  await selectDropdownByLabel(page, 'All models', 'Opus');
  await expect(page.locator(`a.srow[href*="${SESS_OPUS.id}"]`)).toBeVisible();
  await expect(page.locator(`a.srow[href*="${SESS_SONNET.id}"]`)).toHaveCount(0);
});

// ── J4 — Full-text search (read-only) ───────────────────────────────────────
test('@smoke J4 full-text search matches the seeded session', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(`a.srow[href*="${SESS_SONNET.id}"]`)).toBeVisible();

  await page.locator('input.search-input').fill(SESS_SONNET.phrase);
  // Search is debounced 300ms; give it room, then assert on the retrying locators.
  await page.waitForTimeout(500);

  const match = page.locator(`a.srow[href*="${SESS_SONNET.id}"]`);
  await expect(match).toBeVisible();
  await expect(match.locator('.srow-match')).toBeVisible();
  await expect(page.locator(`a.srow[href*="${SESS_OPUS.id}"]`)).toHaveCount(0);
});
