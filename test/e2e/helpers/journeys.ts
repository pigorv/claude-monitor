import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { HAPPY_CORPUS, PLAN_IMPL_CORPUS, PROJECTS_DIR } from './paths.js';

// Shared building blocks for E2E user-journey specs. Read journeys assert on
// specific seeded sessions (the constants below); mutating journeys clear or
// re-import the DB and restore the full baseline on teardown (restoreBaseline).

// ── Known-fixture constants ────────────────────────────────────────────────
// Ids/model families/message phrases below are read from the fixture files the
// boot seed imports (test/fixtures/happy + test/fixtures/plan-impl-pair). Only
// the bits journeys assert on are captured. Verified against the JSONL on disk.

/** happy/sample-session.jsonl — an opus parent session ("Hello, please read my file."). */
export const SESS_OPUS = { id: 'sess-001', model: 'opus', phrase: 'read my file' } as const;

/** happy/sample-agent-transcript.jsonl — a sonnet session ("Find the issue in the config file…"). */
export const SESS_SONNET = { id: 'hook-sess-1', model: 'sonnet', phrase: 'config file' } as const;

/** plan-impl-pair/plan-session.jsonl — the plan side of the plan→impl link. */
export const PLAN_SESSION = 'plan-session-001';

/** plan-impl-pair/impl-session.jsonl — the implementation side of the plan→impl link. */
export const IMPL_SESSION = 'impl-session-001';

// ── Projects-dir seeding ───────────────────────────────────────────────────

/**
 * Copy every `*.jsonl` from both golden corpora into PROJECTS_DIR so a
 * subsequent app **Re-import** (which recursively scans the projects dir)
 * rebuilds the *full* baseline. The boot seed imports the corpora via the CLI
 * from their source locations — NOT the projects dir — so without this a
 * re-import would find nothing to import.
 */
export function seedProjectsDir(): void {
  mkdirSync(PROJECTS_DIR, { recursive: true });
  for (const corpus of [HAPPY_CORPUS, PLAN_IMPL_CORPUS]) {
    for (const name of readdirSync(corpus)) {
      if (name.endsWith('.jsonl')) {
        copyFileSync(join(corpus, name), join(PROJECTS_DIR, name));
      }
    }
  }
}

// ── API helpers ────────────────────────────────────────────────────────────

/** Status body returned by GET /api/reimport/status (see src/server/routes/reimport.ts). */
interface ReimportStatusBody {
  running: boolean;
  phase: string;
  total: number;
  processed: number;
  imported: number;
  errors: number;
  done: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

const REIMPORT_POLL_INTERVAL_MS = 250;
const REIMPORT_TIMEOUT_MS = 30_000;

/**
 * Kick off a re-import and poll until it reports `done`. POST /api/reimport
 * returns 202 `{started:true}` on a fresh start or 409 `{started:false}` if a
 * run is already in flight — either way we just attach to the status poll.
 */
export async function reimportViaApi(request: APIRequestContext): Promise<ReimportStatusBody> {
  await request.post('/api/reimport');

  const deadline = Date.now() + REIMPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await request.get('/api/reimport/status');
    const body = (await res.json()) as ReimportStatusBody;
    if (body.done) return body;
    await new Promise((resolve) => setTimeout(resolve, REIMPORT_POLL_INTERVAL_MS));
  }
  throw new Error(`reimportViaApi: timed out after ${REIMPORT_TIMEOUT_MS}ms waiting for done`);
}

/** Wipe all sessions/events. POST /api/clear requires `confirm=true` or it 400s. */
export async function clearDbViaApi(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/clear?confirm=true');
  if (!res.ok()) {
    throw new Error(`clearDbViaApi: expected 2xx, got ${res.status()}`);
  }
}

/**
 * Rebuild the full baseline (both corpora) into the DB: seed the projects dir,
 * then re-import. Used by mutating journeys' teardown to leave the DB as the
 * boot seed found it.
 */
export async function restoreBaseline(request: APIRequestContext): Promise<void> {
  seedProjectsDir();
  await reimportViaApi(request);
}

// ── FilterBar Dropdown interaction ─────────────────────────────────────────
// The FilterBar uses a CUSTOM dropdown (frontend/src/components/Dropdown.tsx),
// not a native <select>: root `div.dd-root` (gains `dd-open`), trigger button
// `button.dd-trigger` (label in `span.dd-trigger-label`), popover
// `div.dd-popover[role="listbox"]` with `div.dd-option[role="option"]` entries.

/** Anchored regex for whole-string text matching (labels here contain no regex metacharacters). */
function exact(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`);
}

/**
 * Open the FilterBar dropdown whose trigger currently shows `triggerLabel`
 * (e.g. `All models`, `↓ Latest`) and click the option whose text is
 * `optionLabel`. Scoped to the matching `.dd-root` so multiple dropdowns on the
 * page never collide.
 *
 * Model option labels: `All models`, `Fable`, `Opus`, `Sonnet`, `Haiku`.
 * Sort option labels include: `↓ Latest`, `↑ Oldest`, `↓ Longest duration`,
 * `↑ Shortest duration`, `↓ Highest ctx %`, `↓ Most expensive`, `Project A→Z`,
 * `Model A→Z`.
 */
export async function selectDropdownByLabel(
  page: Page,
  triggerLabel: string,
  optionLabel: string,
): Promise<void> {
  const root = page.locator('div.dd-root').filter({
    has: page.locator('span.dd-trigger-label', { hasText: exact(triggerLabel) }),
  });
  await root.locator('button.dd-trigger').click();
  await root
    .locator('div.dd-popover[role="listbox"] div.dd-option[role="option"]', {
      hasText: exact(optionLabel),
    })
    .click();
}
