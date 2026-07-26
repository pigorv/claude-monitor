// E2E full (nightly) user journeys 5-6 (issue #146, T3.1). These drive the REAL
// built CLI/server (baseURL configured in playwright.config.ts) seeded at boot
// with two corpora: happy/ (sess-001 opus, hook-sess-1 sonnet) and
// plan-impl-pair/. NOT tagged @smoke — that tag is reserved for journeys 1-4.
//
// Robustness rules applied throughout:
//  - Assert on the specific seeded/fresh ids below, never on exact global totals
//    (sibling mutating specs change them).
//  - Prefer auto-retrying expect() over fixed waits.
//  - J5 mutates the DB (adds a fresh session), so it lives in its own serial
//    describe and restores the exact two-corpus baseline on teardown; its
//    assertions are watcher-tolerant (end-state presence only). J6 is read-only.
import { test, expect } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESS_OPUS, clearDbViaApi, restoreBaseline } from '../helpers/journeys.js';
import { PROJECTS_DIR } from '../helpers/paths.js';

// ── J5 — Re-import → new/updated data (MUTATING; serial; self-restoring) ─────
// A fresh transcript is written into the projects dir, then a Settings
// Re-import pulls it in and its row appears. afterAll deletes the file and
// rebuilds the exact baseline so later/other specs see order-independent state.
test.describe('J5 re-import new data', () => {
  test.describe.configure({ mode: 'serial' });

  const NEW_ID = 'e2e-reimport-001';
  const NEW_FILE = join(PROJECTS_DIR, `${NEW_ID}.jsonl`);

  // Minimal but importable transcript: a user line + an assistant line carrying
  // message.model + message.usage. Shape modeled on happy/sample-session.jsonl.
  const transcript =
    [
      {
        parentUuid: null,
        cwd: '/tmp/e2e-reimport',
        sessionId: NEW_ID,
        version: '2.1.0',
        type: 'user',
        message: { role: 'user', content: 'Hello from the re-import journey.' },
        timestamp: '2026-02-01T00:00:00.000Z',
        uuid: 'e2e-reimport-user-1',
      },
      {
        parentUuid: 'e2e-reimport-user-1',
        cwd: '/tmp/e2e-reimport',
        sessionId: NEW_ID,
        version: '2.1.0',
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          role: 'assistant',
          content: [{ type: 'text', text: 'Acknowledged the re-import journey.' }],
          usage: {
            input_tokens: 1200,
            output_tokens: 90,
            cache_read_input_tokens: 600,
            cache_creation_input_tokens: 0,
          },
        },
        timestamp: '2026-02-01T00:00:05.000Z',
        uuid: 'e2e-reimport-asst-1',
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n';

  test.afterAll(async ({ request }) => {
    // Remove the extra transcript, then wipe + rebuild so the DB returns to the
    // exact two-corpus baseline (the fresh session is pruned).
    rmSync(NEW_FILE, { force: true });
    await clearDbViaApi(request);
    await restoreBaseline(request);
  });

  test('J5 re-import: write new transcript → Re-import → row appears', async ({ page }) => {
    // 1. The fresh id is not present yet (its file does not exist).
    await page.goto('/');
    await expect(page.locator(`a.srow[href*="${NEW_ID}"]`)).toHaveCount(0);

    // 2. Write the new transcript into the projects dir.
    writeFileSync(NEW_FILE, transcript, 'utf8');

    // 3. Drive Re-import through the Settings UI.
    await page.goto('#/settings');
    const reimportBtn = page.getByRole('button', { name: 'Re-import' });
    await expect(reimportBtn).toBeEnabled();
    await reimportBtn.click();
    await expect(page.locator('p.settings-hint', { hasText: /Imported/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(reimportBtn).toBeEnabled();

    // 4. The new row appears on the list (watcher-tolerant end-state assertion).
    await page.goto('/');
    await expect(page.locator(`a.srow[href*="${NEW_ID}"]`)).toBeVisible();
  });
});

// ── J6 — Export a session bundle → validate zip (read-only) ──────────────────
test('J6 export session: sanitized bundle downloads as a valid zip', async ({ page }) => {
  await page.goto(`#/session/${SESS_OPUS.id}`);
  await expect(page.locator('.session-detail')).toBeVisible();

  // Open the export modal from the header.
  await page.locator('button.export-btn-header').click();
  const sanitizedRow = page.locator('button.export-row.sanitized');
  await expect(sanitizedRow).toBeVisible();

  // The frontend downloads via a blob + <a download> anchor; Playwright captures
  // it as a `download` event.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    sanitizedRow.click(),
  ]);

  // Filename is the server-provided, sanitized (no -raw) name.
  expect(download.suggestedFilename()).toBe(`claude-monitor-session-${SESS_OPUS.id}.zip`);

  const savePath = join(tmpdir(), `claude-monitor-e2e-j6-${SESS_OPUS.id}.zip`);
  await download.saveAs(savePath);
  const bytes = readFileSync(savePath);

  // Non-empty and starts with the ZIP local-file magic (PK\x03\x04).
  expect(bytes.length).toBeGreaterThan(0);
  expect(bytes[0]).toBe(0x50);
  expect(bytes[1]).toBe(0x4b);
  expect(bytes[2]).toBe(0x03);
  expect(bytes[3]).toBe(0x04);

  // Entry filenames are stored uncompressed in the local headers, so an ASCII
  // substring search over the raw buffer is a valid, dependency-free check.
  const raw = bytes.toString('latin1');
  expect(raw).toContain('sanitization-report.json'); // audit entry in every sanitized bundle
  expect(raw).toContain('.jsonl'); // transcript entry (named by transcript FILE basename)

  rmSync(savePath, { force: true });
});
