#!/usr/bin/env node
// Playwright-driven screenshot capture for README feature images.
// Seeds demo data, starts an isolated dashboard, and captures four PNGs:
//   docs/images/session-list.png
//   docs/images/session-detail-timeline.png
//   docs/images/session-detail-context.png
//   docs/images/session-detail-agents.png
//
// NOTE: Not part of the shipped package. Requires `npm run build` to have run.
//
// Usage: npm run demo:screenshots  (or: node scripts/demo-screenshots.mjs)
//
// Optional positional args filter which screenshots to capture by key
// (sessionList | timeline | context | agents). When omitted, captures all four.
//   node scripts/demo-screenshots.mjs sessionList
//   node scripts/demo-screenshots.mjs timeline context

import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4177;
const HOME_DIR = "/tmp/cm-demo-home-screenshots";
const DATA_DIR = "/tmp/cm-demo-data";
const VIEWPORT = { width: 1400, height: 900 };

const OUT = {
  sessionList:     join(ROOT, "docs/images/session-list.png"),
  timeline:        join(ROOT, "docs/images/session-detail-timeline.png"),
  context:         join(ROOT, "docs/images/session-detail-context.png"),
  agents:          join(ROOT, "docs/images/session-detail-agents.png"),
};

// ── Which screenshots? ─────────────────────────────────────────────

const ALL_KEYS = Object.keys(OUT);
const argKeys = process.argv.slice(2);
for (const k of argKeys) {
  if (!ALL_KEYS.includes(k)) {
    console.error(`Unknown screenshot key "${k}". Valid keys: ${ALL_KEYS.join(", ")}`);
    process.exit(1);
  }
}
const WANTED = new Set(argKeys.length ? argKeys : ALL_KEYS);
const want = (key) => WANTED.has(key);

// ── Sanity checks ──────────────────────────────────────────────────

if (!existsSync(join(ROOT, "dist/index.js"))) {
  console.error("dist/index.js missing — run `npm run build` first.");
  process.exit(1);
}

// ── 1. Seed + import ───────────────────────────────────────────────

console.log("→ Seeding demo data");
execSync("node scripts/demo-seed.mjs", { cwd: ROOT, stdio: "inherit" });

console.log("→ Importing into isolated HOME");
rmSync(HOME_DIR, { recursive: true, force: true });
mkdirSync(HOME_DIR, { recursive: true });
execSync(`node dist/index.js import ${DATA_DIR}`, {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, HOME: HOME_DIR },
});

// ── 2. Start the dashboard ─────────────────────────────────────────

console.log(`→ Starting dashboard on :${PORT}`);
const server = spawn(
  "node",
  ["dist/index.js", "start", "--port", String(PORT), "--no-open"],
  {
    cwd: ROOT,
    env: { ...process.env, HOME: HOME_DIR },
    stdio: "ignore",
  },
);

async function waitForHealth(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up within ${timeoutMs}ms`);
}

await waitForHealth(`http://localhost:${PORT}/api/health`);

// ── 3. Launch Playwright (no video) ───────────────────────────────

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

async function goTo(hash) {
  await page.goto(`http://localhost:${PORT}/${hash}`);
}

try {
  // ── Screenshot 1: Session List ─────────────────────────────────
  // Shows recognition-first rows, date-group headers (TODAY/YESTERDAY),
  // right-rail telemetry ledger, and the new filter bar with dropdowns.
  if (want("sessionList")) {
    console.log("→ Capturing session-list.png");
    await goTo("");
    await page.waitForSelector(".srow");
    // Let the layout fully settle (date groups, right-rail tokens)
    await page.waitForTimeout(800);
    await page.screenshot({ path: OUT.sessionList });
  }

  // ── Screenshot 2: Timeline — Write/Edit full-cards ─────────────
  // sess-impl-001: Write (creates base-schema.ts) + Edit (users.ts diff)
  // Shows the USER purple card, Write code card, Edit diff card (+/- lines),
  // and the ASSISTANT gray card — all new in [Unreleased].
  if (want("timeline")) {
    console.log("→ Capturing session-detail-timeline.png");
    await goTo(`#/session/sess-impl-001`);
    // Timeline is the default tab. Capture from the top of the page — like
    // the Context/Agents shots — so the session header (breadcrumb, title,
    // model badge, resume bar, stat cards, tab bar) is in frame above the
    // first timeline events. Wait for the event stream to render, but do
    // NOT scroll into it.
    await page.waitForSelector(".tab-bar");
    await page.waitForSelector(".event-card-write");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: OUT.timeline });
  }

  // ── Screenshot 3: Context chart with compaction drops ──────────
  // sess-notes-002 has two compactions (two distinct input-token drops)
  // producing the warning/danger threshold zones + compaction markers.
  if (want("context")) {
    console.log("→ Capturing session-detail-context.png");
    await goTo(`#/session/sess-notes-002`);
    await page.waitForSelector(".tab-bar");
    await page.getByRole("button", { name: /^Context/ }).click();
    await page.waitForSelector('text="Context utilization over time"');
    await page.waitForTimeout(800); // let the uPlot chart finish rendering
    await page.screenshot({ path: OUT.context });
  }

  // ── Screenshot 4: Agents Gantt ─────────────────────────────────
  // sess-dash-002 has 5 sub-agents running in parallel,
  // producing a 5-row Gantt with per-agent token costs and status badges.
  if (want("agents")) {
    console.log("→ Capturing session-detail-agents.png");
    await goTo(`#/session/sess-dash-002`);
    await page.waitForSelector(".tab-bar");
    await page.getByRole("button", { name: /^Agents/ }).click();
    await page.waitForSelector('text="Agent concurrency"');
    await page.waitForTimeout(800);
    await page.screenshot({ path: OUT.agents });
  }

} finally {
  await page.close();
  await context.close();
  await browser.close();
  server.kill();
}

// ── 4. Report sizes + optional pngquant ───────────────────────────

const hasPngquant = (() => {
  try { execSync("which pngquant", { stdio: "ignore" }); return true; } catch { return false; }
})();

console.log("");
for (const [key, path] of Object.entries(OUT)) {
  if (!want(key)) continue;
  const bytes = parseInt(execSync(`stat -f '%z' "${path}"`).toString().trim(), 10);
  const kb = (bytes / 1024).toFixed(0);
  const warn = bytes > 800_000 ? " ⚠ large" : "";
  console.log(`✓ ${path.replace(ROOT + "/", "")}  ${kb} KB${warn}`);

  if (hasPngquant && bytes > 400_000) {
    console.log(`  → optimizing with pngquant…`);
    try {
      execSync(
        `pngquant --quality=70-90 --skip-if-larger --force --output "${path}" "${path}"`,
        { stdio: "ignore" },
      );
      const after = parseInt(execSync(`stat -f '%z' "${path}"`).toString().trim(), 10);
      console.log(`  → ${(after / 1024).toFixed(0)} KB (saved ${((bytes - after) / 1024).toFixed(0)} KB)`);
    } catch { /* pngquant exits non-zero when --skip-if-larger kicks in */ }
  }
}

console.log("");
console.log("Screenshots written. Review them, then commit alongside any README changes.");
