#!/usr/bin/env node
// Throwaway Playwright-driven walkthrough recorder for the README hero.
// Seeds demo data, starts an isolated dashboard, drives Chromium through a
// scripted tour with a fake cursor + click ripples, captures video, and
// converts it to docs/images/hero.mp4 + docs/images/hero.gif.
//
// NOTE: Not part of the shipped package. Requires `npm run build` to have
// run, plus `ffmpeg` available on PATH for the mp4/gif encode step.
//
// Usage: npm run demo:walkthrough  (or: node scripts/demo-walkthrough.mjs)

import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4175;
const HOME_DIR = "/tmp/cm-demo-home";
const DATA_DIR = "/tmp/cm-demo-data";
const VIDEO_DIR = "/tmp/cm-demo-recordings";
const VIEWPORT = { width: 1400, height: 900 };
const HERO_MP4 = join(ROOT, "docs/images/hero.mp4");
const HERO_GIF = join(ROOT, "docs/images/hero.gif");

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
  deviceScaleFactor: 2, // crisper text in the recording
});

// Fake cursor + click ripple injected into every page. Runs after DOM is
// ready so document.documentElement / document.head exist.
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

// ── Helpers: choreographed cursor + click ──────────────────────────

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no bounding box");
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.evaluate(({ x, y }) => window.__demoCursor.moveTo(x, y), { x, y });
  await page.waitForTimeout(750); // wait for the CSS transition
  return { x, y };
}

async function clickWithRipple(locator) {
  const { x, y } = await moveTo(locator);
  await page.evaluate(({ x, y }) => window.__demoCursor.ripple(x, y), { x, y });
  await page.waitForTimeout(150); // let the ripple appear before the navigation kicks in
  await locator.click();
}

async function dwell(ms) {
  await page.waitForTimeout(ms);
}

// ── The walkthrough ────────────────────────────────────────────────

console.log("→ Recording walkthrough");

try {
  // ── Beat 1: Session list — recognition-first rows + date groups ──
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".srow");
  await page.evaluate(() => window.__demoCursor.moveTo(700, 100));
  await dwell(1100); // breathe — let the eye scan the layout

  // The filter bar has three dropdowns, in order: Project, Model, Sort.
  const projectTrigger = page.locator(".filter-bar .dd-root").nth(0).locator(".dd-trigger");
  const modelTrigger   = page.locator(".filter-bar .dd-root").nth(1).locator(".dd-trigger");
  const sortTrigger    = page.locator(".filter-bar .dd-root").nth(2).locator(".dd-trigger");

  // ── Beat 2: Project dropdown — open, peek, close ─────────────────
  await clickWithRipple(projectTrigger);
  await page.waitForSelector(".filter-bar .dd-root.dd-open .dd-popover");
  await dwell(900); // project list visible
  await clickWithRipple(projectTrigger); // click trigger again → toggle closed
  await dwell(450);

  // ── Beat 3: Model dropdown — open, peek, close ───────────────────
  await clickWithRipple(modelTrigger);
  await page.waitForSelector(".filter-bar .dd-root.dd-open .dd-popover");
  await dwell(900);
  await clickWithRipple(modelTrigger); // toggle closed
  await dwell(450);

  // ── Beat 4: Search — type a query, then clear it ─────────────────
  const searchInput = page.locator(".filter-bar .search-input");
  await clickWithRipple(searchInput);
  await searchInput.pressSequentially("audit", { delay: 95 });
  await dwell(1200); // list narrows to the matching session
  await searchInput.fill("");
  await dwell(700); // full list returns

  // ── Beat 5: Sort dropdown — open, choose "Most expensive" ────────
  await clickWithRipple(sortTrigger);
  await page.waitForSelector(".filter-bar .dd-root.dd-open .dd-popover");
  await dwell(900); // options list visible (Latest, Longest, Most expensive…)
  const expensiveOption = page.locator(".dd-option", { hasText: /Most expensive/ });
  await clickWithRipple(expensiveOption);
  await dwell(1000); // list reorders — the costliest session floats to the top

  // ── Beat 6: Open the top (most expensive) session ────────────────
  // After the cost sort the list is ungrouped; sess-dash-002 (the 5-agent
  // "Audit dashboard rendering performance" run) is the costliest, so it's
  // the first row.
  const topRow = page.locator(".srow", {
    hasText: /Audit dashboard rendering performance/,
  });
  await clickWithRipple(topRow);
  await page.waitForURL(/sess-dash-002/);
  await page.waitForSelector(".tab-bar");

  // ── Beat 7: Timeline tab (default) — the event stream ────────────
  await page.evaluate(() => window.__demoCursor.moveTo(700, 520));
  await dwell(1900); // let the eye walk the 60-event timeline

  // ── Beat 8: Context tab ──────────────────────────────────────────
  const contextTab = page.getByRole("button", { name: /^Context/ });
  await clickWithRipple(contextTab);
  await page.waitForSelector('text="Context utilization over time"');
  await dwell(1600); // chart needs a beat to read

  // ── Beat 9: Agents Gantt — the climax ────────────────────────────
  const agentsTab = page.getByRole("button", { name: /^Agents/ });
  await clickWithRipple(agentsTab);
  await page.waitForSelector('text="Agent concurrency"');
  await dwell(2400); // Gantt is the climax — give it time

  // Final beat: nudge cursor away so the last frame is calm
  await page.evaluate(() => window.__demoCursor.moveTo(1200, 60));
  await dwell(700);
} finally {
  // Closing context flushes the video file. Save its path before close.
  const videoPath = await page.video().path();
  await page.close();
  await context.close();
  await browser.close();
  server.kill();

  console.log(`→ Raw recording: ${videoPath}`);

  // ── 4. ffmpeg convert ───────────────────────────────────────────

  console.log("→ Encoding hero.mp4");
  execSync(
    `ffmpeg -y -loglevel error -i "${videoPath}" -c:v libx264 -crf 22 -preset slow -pix_fmt yuv420p -movflags +faststart "${HERO_MP4}"`,
    { stdio: "inherit" },
  );

  console.log("→ Encoding hero.gif (lower fps + width for size)");
  execSync(
    `ffmpeg -y -loglevel error -i "${videoPath}" -vf "fps=15,scale=1100:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" "${HERO_GIF}"`,
    { stdio: "inherit" },
  );

  // Clean up the raw recordings directory; the encoded outputs are what we keep.
  rmSync(VIDEO_DIR, { recursive: true, force: true });

  // Report
  const mp4Size = (execSync(`stat -f '%z' "${HERO_MP4}"`).toString().trim() / 1024 / 1024).toFixed(2);
  const gifSize = (execSync(`stat -f '%z' "${HERO_GIF}"`).toString().trim() / 1024 / 1024).toFixed(2);
  console.log("");
  console.log(`✓ docs/images/hero.mp4  ${mp4Size} MB`);
  console.log(`✓ docs/images/hero.gif  ${gifSize} MB`);
  console.log("");
  console.log("Next:");
  console.log("  1. Preview: open docs/images/hero.mp4");
  console.log("  2. Drag hero.mp4 into a draft PR comment to get a user-attachments URL.");
  console.log("  3. Replace the <img src=\"...\"> URL in README.md hero block.");
  console.log("  4. Update <!-- hero captured-on: --> to the current version.");
}
