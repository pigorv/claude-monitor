#!/usr/bin/env node
// Throwaway Playwright-driven walkthrough recorder for the long-form
// dashboard tour. Seeds demo data, starts an isolated dashboard (on a
// different port and HOME than the hero recorder so the two can run
// independently), drives Chromium through a longer scripted tour with a
// fake cursor + click ripples, captures video, and converts it to
// docs/images/walkthrough.mp4 (MP4 only — a 2-minute GIF is not viable).
//
// NOTE: Not part of the shipped package. Requires `npm run build` to have
// run, plus `ffmpeg` available on PATH for the mp4 encode step.
//
// Usage: npm run demo:walkthrough-full
//   (or: node scripts/demo-walkthrough-full.mjs)

import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4176;
const HOME_DIR = "/tmp/cm-demo-home-full";
const DATA_DIR = "/tmp/cm-demo-data";
const VIDEO_DIR = "/tmp/cm-demo-recordings-full";
const VIEWPORT = { width: 1400, height: 900 };
const OUT_MP4 = join(ROOT, "docs/images/walkthrough.mp4");

// ── Sanity checks ──────────────────────────────────────────────────

if (!existsSync(join(ROOT, "dist/index.js"))) {
  console.error("dist/index.js missing — run `npm run build` first.");
  process.exit(1);
}

// ── 1. Seed + import ───────────────────────────────────────────────

console.log("→ Seeding /tmp/cm-demo-data");
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

// ── 3. Launch Playwright + record ──────────────────────────────────

rmSync(VIDEO_DIR, { recursive: true, force: true });
mkdirSync(VIDEO_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: VIEWPORT,
  recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
  deviceScaleFactor: 2,
});

// Fake cursor + click ripple — same shape as the hero recorder.
await context.addInitScript(() => {
  const init = () => {
    if (window.__demoCursor) return;

    const style = document.createElement("style");
    style.textContent = `
      #__demo_cursor {
        position: fixed;
        top: 0; left: 0;
        width: 22px; height: 22px;
        pointer-events: none;
        z-index: 2147483646;
        transform: translate(-200px, -200px);
        transition: transform 700ms cubic-bezier(0.22, 0.61, 0.36, 1);
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.3));
      }
      .__demo_ripple {
        position: fixed;
        width: 40px; height: 40px;
        border: 2px solid rgba(124, 58, 237, 0.85);
        border-radius: 50%;
        pointer-events: none;
        z-index: 2147483645;
        transform: translate(-50%, -50%) scale(0.6);
        opacity: 1;
        animation: __demo_ripple 650ms ease-out forwards;
      }
      @keyframes __demo_ripple {
        to { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
      }
    `;
    document.head.appendChild(style);

    const cursor = document.createElement("div");
    cursor.id = "__demo_cursor";
    cursor.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22"><path d="M3 1.5 L19.5 13 L12 14 L16 22 L13 23.2 L9 15 L3 19 Z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    document.documentElement.appendChild(cursor);

    window.__demoCursor = {
      moveTo(x, y) {
        cursor.style.transform = `translate(${x}px, ${y}px)`;
      },
      ripple(x, y) {
        const r = document.createElement("div");
        r.className = "__demo_ripple";
        r.style.left = `${x}px`;
        r.style.top = `${y}px`;
        document.documentElement.appendChild(r);
        setTimeout(() => r.remove(), 700);
      },
    };
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
});

const page = await context.newPage();

// ── Helpers ────────────────────────────────────────────────────────

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(({ x, y }) => window.__demoCursor.moveTo(x, y), { x, y });
  await page.waitForTimeout(750);
  return { x, y };
}

async function clickWithRipple(locator) {
  const { x, y } = await moveTo(locator);
  await page.evaluate(({ x, y }) => window.__demoCursor.ripple(x, y), { x, y });
  await page.waitForTimeout(150);
  await locator.click();
}

async function dwell(ms) {
  await page.waitForTimeout(ms);
}

// Type text character-by-character so the viewer sees the search list narrow.
async function typeInto(locator, text, delayMs = 90) {
  await moveTo(locator);
  await locator.click();
  await locator.type(text, { delay: delayMs });
}

async function clearInput(locator) {
  await locator.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Delete");
  // Some platforms need the Ctrl variant; harmless if Meta already worked.
  await locator.fill("");
}

async function gotoSession(id) {
  await page.goto(`http://localhost:${PORT}/#/session/${id}`);
  await page.waitForSelector(".tab-bar");
}

// ── The walkthrough ────────────────────────────────────────────────

console.log("→ Recording walkthrough");

try {
  // ── Beat 1: SessionList tour ────────────────────────────────────
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector("table tbody tr");
  await page.evaluate(() => window.__demoCursor.moveTo(700, 100));
  await dwell(1500);

  // 1a. Search → narrows the list to dashboard-rendering sessions
  const searchInput = page.locator("input.search-input");
  await typeInto(searchInput, "audit");
  await dwell(1200);
  await clearInput(searchInput);
  await dwell(400);

  // 1b. Model chip filter: Sonnet → All
  const sonnetChip = page.locator(".filter-chips .chip", { hasText: /^Sonnet$/ });
  await clickWithRipple(sonnetChip);
  await dwell(1000);
  const allChip = page.locator(".filter-chips .chip", { hasText: /^All$/ });
  await clickWithRipple(allChip);
  await dwell(600);

  // 1c. Sort by Duration
  const durationHeader = page.locator("th.sortable", { hasText: /^Duration$/ });
  await clickWithRipple(durationHeader);
  await dwell(900);

  // 1d. Expand skill pills overflow on sess-dash-002 (4 skills → +1 more)
  const dashRow = page.locator("tbody tr", { hasText: /Audit dashboard rendering performance/ });
  const moreChip = dashRow.locator("span.pill-more");
  await clickWithRipple(moreChip);
  await dwell(1300);

  // 1e. Hover Health strip on the high-pressure notes session
  const notesRow = page.locator("tbody tr", { hasText: /Migrate notes storage from JSON to SQLite/ });
  const healthCell = notesRow.locator("td").last();
  await moveTo(healthCell);
  await dwell(1000);

  // ── Beat 2: Linked Sessions ─────────────────────────────────────
  const implRow = page.locator("tbody tr", { hasText: /Implement: shared zod validation schema/ });
  await clickWithRipple(implRow);
  await page.waitForURL(/sess-impl-001/);
  await page.waitForSelector(".linked-sessions");
  await dwell(1200);

  const planningLink = page.locator("a.linked-session-link", { hasText: /Planning Session/ });
  await moveTo(planningLink);
  await dwell(1500);
  await clickWithRipple(planningLink);
  await page.waitForURL(/sess-plan-001/);
  await dwell(1500);

  // ── Beat 3: Timeline depth — tool-by-tool expansion ─────────────
  // 3a. On sess-impl-001 we have Read → Write → Edit → Bash in order.
  await gotoSession("sess-impl-001");
  await page.waitForSelector("div.tool-row-standalone");
  await dwell(800);

  // Read
  const readRow = page.locator("div.tool-row-standalone", { has: page.locator("span.tool-badge", { hasText: "Read" }) }).first();
  await clickWithRipple(readRow);
  await dwell(2000);

  // Write
  const writeRow = page.locator("div.tool-row-standalone", { has: page.locator("span.tool-badge", { hasText: "Write" }) }).first();
  await clickWithRipple(writeRow);
  await dwell(2000);

  // Edit — climax of the tool-expansion beat; renders +/- diff
  const editRow = page.locator("div.tool-row-standalone", { has: page.locator("span.tool-badge", { hasText: "Edit" }) }).first();
  await clickWithRipple(editRow);
  await page.waitForSelector(".diff-view");
  await dwell(2800);

  // Bash
  const bashRow = page.locator("div.tool-row-standalone", { has: page.locator("span.tool-badge", { hasText: "Bash" }) }).first();
  await clickWithRipple(bashRow);
  await dwell(2000);

  // 3b. Skill + Agent — sess-dash-002 has both, plus the 4-skill overflow data.
  await gotoSession("sess-dash-002");
  await page.waitForSelector(".timeline, .event-card, div.tool-row-standalone");
  await dwell(800);

  // Skill expansion event (skill-badge with "skill:" prefix)
  const skillEvent = page.locator(".event-skill-expansion").first();
  await clickWithRipple(skillEvent);
  await dwell(2000);

  // Agent invocation block — rendered by AgentGroup as `.agent-block`.
  // Clicking the header expands the block; on first expand the body lazy-loads
  // the agent's child events (visible briefly as a "Loading agent events…" hint).
  const agentBlockHeader = page.locator(".agent-block .agent-block-header").first();
  await clickWithRipple(agentBlockHeader);
  await dwell(2500);

  // ── Beat 4: Context tab ─────────────────────────────────────────
  const contextTab = page.getByRole("button", { name: /^Context/ });
  await clickWithRipple(contextTab);
  await page.waitForSelector('text="Context utilization over time"');
  await dwell(1800);

  // Drift cursor onto the chart so the uPlot crosshair tooltip appears
  const chart = page.locator(".chart-container").first();
  await moveTo(chart);
  await dwell(1500);

  // ── Beat 5: Agents tab ──────────────────────────────────────────
  const agentsTab = page.getByRole("button", { name: /^Agents/ });
  await clickWithRipple(agentsTab);
  await page.waitForSelector('text="Agent concurrency"');
  await dwell(1500);

  // Select the first Gantt row — the agent-detail panel renders with stats,
  // prompt/result, and the tool-call list.
  const ganttRows = page.locator(".gantt-row");
  await clickWithRipple(ganttRows.nth(0));
  await page.waitForSelector(".agent-detail .tool-list-expanded");
  await dwell(1500);

  // Scroll down to the tool list and expand the first tool to surface its
  // input/output detail grid.
  const firstToolHeader = page.locator(".agent-detail .tool-row-exp .tool-row-header").first();
  await clickWithRipple(firstToolHeader);
  await dwell(2200);

  // Switch to a second sub-agent and repeat the tool expansion so the viewer
  // sees that each agent has its own captured tool sequence.
  await clickWithRipple(ganttRows.nth(1));
  await page.waitForSelector(".agent-detail .tool-list-expanded");
  await dwell(1200);

  const secondAgentTool = page.locator(".agent-detail .tool-row-exp .tool-row-header").nth(1);
  await clickWithRipple(secondAgentTool);
  await dwell(2200);

  // Final beat: park cursor away
  await page.evaluate(() => window.__demoCursor.moveTo(1200, 60));
  await dwell(800);
} finally {
  const videoPath = await page.video().path();
  await page.close();
  await context.close();
  await browser.close();
  server.kill();

  console.log(`→ Raw recording: ${videoPath}`);

  // ── 4. ffmpeg convert (MP4 only) ────────────────────────────────
  console.log("→ Encoding walkthrough.mp4");
  execSync(
    `ffmpeg -y -loglevel error -i "${videoPath}" -c:v libx264 -crf 22 -preset slow -pix_fmt yuv420p -movflags +faststart "${OUT_MP4}"`,
    { stdio: "inherit" },
  );

  rmSync(VIDEO_DIR, { recursive: true, force: true });

  const mp4Size = (execSync(`stat -f '%z' "${OUT_MP4}"`).toString().trim() / 1024 / 1024).toFixed(2);
  console.log("");
  console.log(`✓ docs/images/walkthrough.mp4  ${mp4Size} MB`);
  console.log("");
  console.log("Next:");
  console.log("  open docs/images/walkthrough.mp4");
}
