#!/usr/bin/env node
// Throwaway Playwright-driven recorder for the README's per-feature clips.
// Seeds demo data, starts an isolated dashboard (its own port and HOME so it
// can run alongside the hero recorders), drives Chromium through one short
// scripted flow per feature with a fake cursor + click ripples, and converts
// each recording to docs/images/<feature>.gif.
//
// Unlike the hero (one long tour of the whole app), these are 8-12s single-
// feature loops that sit inline next to their feature paragraph, so each one
// is recorded in its own browser context and encoded narrower/slower to stay
// well under the README's 1.5 MB per-image budget.
//
// Everything is written under /tmp/cm-demo-home-clips — including the session
// the Clone flow actually writes to disk — so a run never touches the real
// ~/.claude/projects or ~/.claude-monitor.
//
// NOTE: Not part of the shipped package. Requires `npm run build` to have
// run, plus `ffmpeg` available on PATH for the gif encode step.
//
// Usage: npm run demo:clips            (records every clip)
//        npm run demo:clips -- clone   (records just one)

import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4177;
const HOME_DIR = "/tmp/cm-demo-home-clips";
const DATA_DIR = "/tmp/cm-demo-data";
const VIDEO_DIR = "/tmp/cm-demo-recordings-clips";
const DOWNLOAD_DIR = "/tmp/cm-demo-downloads";
const VIEWPORT = { width: 1400, height: 900 };

// The session every clip is filmed on: a long Sonnet→Opus run with a
// compaction, rooted in the api-server demo project.
const SESSION_ID = "sess-api-001";

// Target directory the Clone flow re-roots the session into. Lives under the
// isolated HOME so `~` expands to it in the modal — which keeps the typed path
// short and generic on screen instead of leaking a real home directory.
const CLONE_TARGET_REL = "work/api-server-v2";
const CLONE_TARGET_TYPED = `~/${CLONE_TARGET_REL}`;

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
// The clone target has to exist before the flow runs — cloneSession rejects a
// non-existent directory with `bad_target_dir`.
mkdirSync(join(HOME_DIR, CLONE_TARGET_REL), { recursive: true });
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

// ── 3. Fake cursor + click ripple ──────────────────────────────────
//
// Same choreography helper the hero recorder uses: a synthetic pointer the
// viewer can follow, since a real headless cursor isn't captured on video.

const CURSOR_INIT = () => {
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
};

// ── 4. Clip definitions ────────────────────────────────────────────
//
// Each clip gets a fresh browser context (one video file per context) and a
// `flow(page, helpers)` that drives its feature end to end.

const CLIPS = [
  {
    name: "clone",
    out: "docs/images/clone.gif",
    async flow(page, { moveTo, clickWithRipple, dwell }) {
      await page.goto(`http://localhost:${PORT}/#/session/${SESSION_ID}`);
      await page.waitForSelector(".tab-bar");
      await page.evaluate(() => window.__demoCursor.moveTo(560, 300));
      await dwell(700); // establish the session detail header

      // Open the Clone modal from the page header.
      await clickWithRipple(page.locator(".clone-btn-header"));
      await page.waitForSelector(".clone-input");
      await dwell(1100); // read the modal: prefilled with the recorded path

      // Retype the target directory. selectText + pressSequentially reads as
      // deliberate typing on video, where `fill` would snap in instantly.
      const input = page.locator(".clone-input");
      await clickWithRipple(input);
      await input.selectText();
      await dwell(250);
      await input.pressSequentially(CLONE_TARGET_TYPED, { delay: 70 });
      await dwell(600);

      // Clone → success view (resume command, Open in Terminal, open link).
      // Scope to .clone-success: the session detail page behind the modal has
      // its own .resume-cmd-text, so an unscoped locator is ambiguous.
      await clickWithRipple(page.locator(".clone-submit-btn"));
      await page.waitForSelector(".clone-success");
      await dwell(500);
      await moveTo(page.locator(".clone-success .resume-cmd-text"));
      await dwell(2200); // the payoff — let the `claude --resume <id>` read
    },
  },
  {
    name: "export",
    out: "docs/images/export.gif",
    async flow(page, { moveTo, clickWithRipple, dwell }) {
      await page.goto(`http://localhost:${PORT}/#/session/${SESSION_ID}`);
      await page.waitForSelector(".tab-bar");
      await page.evaluate(() => window.__demoCursor.moveTo(560, 300));
      await dwell(900); // establish the session detail header

      // Open the Export modal from the page header.
      await clickWithRipple(page.locator(".export-btn-header"));
      await page.waitForSelector(".export-row.sanitized");
      await dwell(1200);

      // Walk both options so the viewer reads the Sanitized/Raw trade-off,
      // then take the recommended one.
      await moveTo(page.locator(".export-row.raw"));
      await dwell(1500);
      await moveTo(page.locator(".export-row.sanitized"));
      await dwell(1200);

      // Selecting a row starts the download and closes the dialog.
      const download = page.waitForEvent("download");
      await clickWithRipple(page.locator(".export-row.sanitized"));
      const file = await download;
      await file.saveAs(join(DOWNLOAD_DIR, file.suggestedFilename()));
      await dwell(1800); // modal closes, download lands
    },
  },
];

// ── 5. Record ──────────────────────────────────────────────────────

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const selected = only.length ? CLIPS.filter((c) => only.includes(c.name)) : CLIPS;

if (!selected.length) {
  server.kill();
  console.error(`No clip matched ${only.join(", ")}. Known: ${CLIPS.map((c) => c.name).join(", ")}`);
  process.exit(1);
}

rmSync(VIDEO_DIR, { recursive: true, force: true });
mkdirSync(VIDEO_DIR, { recursive: true });
rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];

try {
  for (const clip of selected) {
    console.log(`→ Recording ${clip.name}`);

    const context = await browser.newContext({
      viewport: VIEWPORT,
      recordVideo: { dir: VIDEO_DIR, size: VIEWPORT },
      deviceScaleFactor: 2, // crisper text in the recording
      acceptDownloads: true,
    });
    await context.addInitScript(CURSOR_INIT);
    const page = await context.newPage();

    // Choreographed cursor + click helpers, bound to this clip's page.
    const moveTo = async (locator) => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error("element has no bounding box");
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      await page.evaluate(({ x, y }) => window.__demoCursor.moveTo(x, y), { x, y });
      await page.waitForTimeout(750); // wait for the CSS transition
      return { x, y };
    };
    const clickWithRipple = async (locator) => {
      const { x, y } = await moveTo(locator);
      await page.evaluate(({ x, y }) => window.__demoCursor.ripple(x, y), { x, y });
      await page.waitForTimeout(150); // let the ripple land before the click
      await locator.click();
    };
    const dwell = (ms) => page.waitForTimeout(ms);

    let flowError = null;
    try {
      await clip.flow(page, { moveTo, clickWithRipple, dwell });
    } catch (err) {
      // Encode what was captured anyway (it usually shows where the flow broke),
      // and keep going so one bad selector doesn't cost every other clip.
      flowError = err;
      console.error(`✗ ${clip.name} flow failed: ${err.message}`);
    } finally {
      // Closing the context flushes the video file. Save its path first.
      const videoPath = await page.video().path();
      await page.close();
      await context.close();

      const outPath = join(ROOT, clip.out);
      console.log(`→ Encoding ${clip.out}`);
      // Narrower + slower than the hero: these render inline at width="700",
      // and 10fps/820px keeps a ~12s clip under the README's 1.5 MB budget with
      // room to spare (860px/128 colors landed right on the line).
      execSync(
        `ffmpeg -y -loglevel error -i "${videoPath}" -vf "fps=10,scale=820:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=112[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" "${outPath}"`,
        { stdio: "inherit" },
      );
      results.push({ clip: clip.name, out: clip.out, path: outPath, failed: flowError !== null });
    }
  }
} finally {
  await browser.close();
  server.kill();

  // The encoded gifs are what we keep; drop the raw recordings + downloads.
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  rmSync(DOWNLOAD_DIR, { recursive: true, force: true });

  console.log("");
  for (const r of results) {
    const mb = (execSync(`stat -f '%z' "${r.path}"`).toString().trim() / 1024 / 1024).toFixed(2);
    console.log(`${r.failed ? "✗" : "✓"} ${r.out}  ${mb} MB${r.failed ? "  (flow failed — do not commit)" : ""}`);
  }
  console.log("");
  console.log("Next:");
  console.log("  1. Preview each gif before committing.");
  console.log("  2. Reference it inside its feature paragraph in README.md with an");
  console.log("     absolute raw.githubusercontent.com URL and width=\"700\".");

  if (results.some((r) => r.failed)) process.exitCode = 1;
}
