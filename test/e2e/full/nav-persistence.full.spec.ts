// E2E full (nightly) user journeys 7-8 (issue #146, T3.2). These drive the REAL
// built CLI/server (baseURL configured in playwright.config.ts) seeded at boot
// with two corpora: happy/ (sess-001 opus, hook-sess-1 sonnet) and
// plan-impl-pair/ (plan-session-001, impl-session-001 — linked at boot). NOT
// tagged @smoke — that tag is reserved for journeys 1-4.
//
// Robustness rules applied throughout:
//  - Assert only on the specific seeded ids below, never on exact global totals
//    (sibling mutating specs change them).
//  - Prefer auto-retrying expect() over fixed waits.
//  - Both journeys are READ-ONLY (no DB mutation), so neither needs serial mode
//    or teardown. J8's localStorage writes are confined to Playwright's
//    per-test isolated browser context and never leak to sibling tests.
import { test, expect } from '@playwright/test';
import {
  SESS_OPUS,
  SESS_SONNET,
  PLAN_SESSION,
  IMPL_SESSION,
  selectDropdownByLabel,
} from '../helpers/journeys.js';

// ── J7 — Plan↔implementation link navigation (read-only) ─────────────────────
// The impl session renders a linked-session card back to its planning session
// (session_link created at boot). Clicking it lands on the planning session.
test('J7 link nav: implementation session → planning session', async ({ page }) => {
  await page.goto(`#/session/${IMPL_SESSION}`);
  await expect(page.locator('.session-detail')).toBeVisible();

  // At least one linked-session card renders. There may be MORE than one:
  // /api/clear does not wipe session_links, so a prior spec's re-import can
  // leave a duplicate link — tolerate >= 1, never assert an exact count.
  const links = page.locator('a.linked-session-link');
  await expect(links.first()).toBeVisible();
  expect(await links.count()).toBeGreaterThanOrEqual(1);

  // The planning-session link points at plan-session-001 and is labelled
  // "Planning Session". Use .first() in case a duplicate link exists.
  const planLink = page
    .locator(`a.linked-session-link[href*="${PLAN_SESSION}"]`)
    .first();
  await expect(planLink).toBeVisible();
  await expect(planLink.locator('.linked-label')).toHaveText('Planning Session');

  // Click it and confirm navigation landed on the planning session.
  await planLink.click();
  await expect(page).toHaveURL(new RegExp(PLAN_SESSION));
  await expect(page.locator('.session-detail')).toBeVisible();
  await expect(page.locator('.session-title')).toBeVisible();
});

// ── J8 — Settings persistence across reload (read-only) ──────────────────────
// "Settings persistence" = the session-list model/sort preferences persist
// across a fresh page load via localStorage (Tier-2 prefs: cm.sessionList.*).
// Applying a filter also writes URL params, so we reload to a CLEAN url (no
// query params) — there the stored localStorage pref is what re-applies, which
// is the persistence this journey proves.
test('J8 settings persistence: model + sort prefs survive a fresh load', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator(`a.srow[href*="${SESS_OPUS.id}"]`)).toBeVisible();

  // Apply a model filter (Sonnet) and a sort (Oldest). Both write localStorage.
  await selectDropdownByLabel(page, 'All models', 'Sonnet');
  await selectDropdownByLabel(page, '↓ Latest', '↑ Oldest');

  // The filter took effect: sonnet row stays, opus row drops out.
  await expect(page.locator(`a.srow[href*="${SESS_SONNET.id}"]`)).toBeVisible();
  await expect(page.locator(`a.srow[href*="${SESS_OPUS.id}"]`)).toHaveCount(0);

  // Reload to a CLEAN url (no query params). parseHash yields no params, so the
  // stored localStorage pref — not a URL param — is what drives the view.
  await page.goto('/');

  // The preference persisted: both dropdown triggers show the stored choice.
  await expect(
    page.locator('span.dd-trigger-label', { hasText: 'Sonnet' }),
  ).toBeVisible();
  await expect(
    page.locator('span.dd-trigger-label', { hasText: '↑ Oldest' }),
  ).toBeVisible();

  // And the filtered rows still reflect the persisted Sonnet filter.
  await expect(page.locator(`a.srow[href*="${SESS_SONNET.id}"]`)).toBeVisible();
  await expect(page.locator(`a.srow[href*="${SESS_OPUS.id}"]`)).toHaveCount(0);
});
