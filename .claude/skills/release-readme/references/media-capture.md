# Media capture

Recipes for screenshots and short videos/GIFs of the dashboard, plus the **hero re-capture decision matrix** the skill uses in step 3.

## Standard targets

| File                                  | Page                              | What's on screen                                                                       |
|---------------------------------------|-----------------------------------|----------------------------------------------------------------------------------------|
| `docs/images/session-list.png`        | `/#/`                             | Filterable session table — at least one project chip selected, ≥6 rows visible.        |
| `docs/images/session-detail-context.png` | `/#/sessions/<id>` Context tab | Token chart with at least one compaction marker visible, threshold zones shaded.       |
| `docs/images/session-detail-timeline.png` | `/#/sessions/<id>` Timeline tab | Several event cards expanded, including a thinking block and a tool call.              |
| `docs/images/session-detail-agents.png` | `/#/sessions/<id>` Agents tab  | Gantt with ≥3 agents, at least one nested.                                             |
| Hero (video or GIF)                   | Walkthrough                       | 6–10 seconds: list → click row → switch tabs.                                           |

---

## Hero re-capture decision

The skill must output one verdict per run: **REQUIRED**, **RECOMMENDED**, or **NOT NEEDED**, with a one-paragraph reason citing the specific CHANGELOG entries that drove the decision.

### Inputs

1. The hero's **captured-on** version, read from the `<!-- hero captured-on: vX.Y.Z -->` annotation inside `<!-- hero:start -->`. If absent, treat as `v0.0.0`.
2. The list of routes/surfaces the hero walkthrough traverses. For claude-monitor today this is:
   - `/#/`  (Session List)
   - `/#/sessions/<id>`  (Session Detail header + each tab the hero shows: Context, Timeline, Agents)
   - Any chip/filter/button that's prominently visible during the walkthrough
3. The CHANGELOG range slice the user asked for (`since=<ver>` etc.). The relevant comparison range is **max(captured-on, range-start) → HEAD**.

### Decision rules

A CHANGELOG entry **affects the hero** when its key (per `references/changelog-aggregation.md`) maps to one of the hero routes/surfaces. Apply this matrix:

| Entry kind                                                                            | Verdict shift |
|---------------------------------------------------------------------------------------|---------------|
| `Added` — a new tab/page on a hero route                                              | → **REQUIRED** |
| `Added` — a new always-visible button/control on a hero route (e.g., "Open in Terminal" on every session detail) | → **REQUIRED** |
| `Added` — a new always-visible column or strip on a hero route (e.g., Health strip on session list) | → **REQUIRED** |
| `Changed` — a hero route is structurally re-laid-out                                  | → **REQUIRED** |
| `Changed` — a non-trivial visual update on a hero route (badge colors, renamed labels, new icons) | → **RECOMMENDED** |
| `Removed` — something visible on the hero route                                       | → **REQUIRED** if the hero would now show a stale UI |
| `Added`/`Changed` — a CLI command, server route, or background behavior with no UI surface | → no shift |
| `Fixed`                                                                               | → no shift |

The skill takes the **highest** verdict that any in-range entry triggers. If multiple entries hit different rows, list them all in the reason.

### Format the verdict

```
Hero verdict: REQUIRED  (captured-on: v0.3.1 → HEAD = [Unreleased])

Reason:
  - [Unreleased] adds an "Open in Terminal" button on every session detail
    page (always-visible control on a hero route → REQUIRED).
  - [Unreleased] changes the session list trailing column to a Health strip
    (always-visible column on a hero route → REQUIRED).
  - [Unreleased] collapses the Agents "Result returned" by default — minor
    visual change on a hero route (RECOMMENDED, subsumed by REQUIRED above).

Recommendation: re-record hero to capture the new always-visible UI before release.
After capture, update the annotation to:
  <!-- hero captured-on: v0.4.0 -->
```

### When the verdict is REQUIRED but the user wants to defer

- Do **not** rewrite the `<!-- hero captured-on: -->` annotation. Leaving it stale is the right behavior — the next run will still flag REQUIRED.
- Do **not** recapture without explicit user approval.
- Note in the report: "Hero re-capture deferred. Annotation left at vX.Y.Z; next /readme run will re-flag REQUIRED."

### When the user replaces the hero

- The new asset can be a GitHub user-attachments URL (current pattern), a local `docs/images/hero.gif`, or `docs/images/hero.mp4`. The skill writes whichever the user provides into the marker block.
- Update the annotation to the version that's about to ship (usually the version under `[Unreleased]` once the user has decided what it'll be — or `package.json`'s current version if they haven't bumped yet, with a note in the report).

---

## Pre-capture: get the dashboard to a representative state

The dashboard reads from `~/.claude-monitor/data.sqlite`. For nice screenshots you want sessions with realistic length, a compaction or two, and at least one Task/Agent call.

1. **Real data**: pick an interesting session you've already run. Note its ID; the URL is `/#/sessions/<id>`.
2. **Demo seed**: if `npm run demo:seed` exists, run it to populate a separate demo DB. Confirm the script exists in `package.json` before assuming.

Then start the server in a terminal that stays up while Playwright drives it:

```bash
npm run build
node dist/index.js start --no-open --port 4173 --db ~/.claude-monitor/data.sqlite
```

## Screenshot recipe (per page)

```bash
playwright-cli open
playwright-cli resize 1400 900
playwright-cli goto "http://localhost:4173/#/"
playwright-cli eval "document.querySelectorAll('table tbody tr').length"   # expect >0
playwright-cli snapshot
playwright-cli click <ref-of-project-chip>
playwright-cli screenshot --filename docs/images/session-list.png

playwright-cli goto "http://localhost:4173/#/sessions/<id>"
playwright-cli click <tab-ref>
playwright-cli screenshot --filename docs/images/session-detail-<tab>.png
```

After each capture:

```bash
file docs/images/session-list.png      # expect "PNG image data, 1400 x 900"

# File size sanity. macOS (BSD stat) and Linux (GNU stat) take different flags —
# pick the right one for your platform, or just use `wc -c` which is portable.
stat -f '%z %N' docs/images/*.png      # macOS / BSD
# stat -c '%s %n' docs/images/*.png    # Linux / GNU
# 100KB–800KB healthy; multi-MB needs optimization.
```

If files are >1 MB and `pngquant` is installed:

```bash
pngquant --quality=70-90 --skip-if-larger --output <out>.png <in>.png
```

## Hero recipe (video or GIF)

### Option A — Playwright video → ffmpeg → GIF

Drive a 6–10s walkthrough via the playwright Node API (the CLI snapshot mode is too step-by-step). The canonical recipe lives in `.claude/skills/playwright-cli/references/video-recording.md`. Convert the resulting MP4:

```bash
# MP4 (preferred; smaller, smoother)
ffmpeg -i walk.webm -c:v libx264 -crf 22 -preset slow -pix_fmt yuv420p docs/images/hero.mp4

# GIF fallback (for places that don't render <video>)
ffmpeg -i walk.webm -vf "fps=12,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" docs/images/hero.gif
```

Target: ≤5 MB GIF, ≤8 MB MP4. If the GIF is over budget, prefer MP4 and embed via `<video>`.

### Option B — GitHub user-attachments URL (current pattern)

1. Open a **draft PR** on the repo (issues don't have a draft state — use a PR or a regular issue you'll close after copying the URL).
2. Drag the new `.mp4` into the comment box; GitHub uploads it and rewrites the markdown as `https://github.com/user-attachments/assets/<id>`. Copy that URL.
3. Paste it into the `<video src="…">` inside the `<!-- hero:* -->` block.
4. Leave the PR as draft (or close the throwaway issue without commenting) — the asset URL keeps working either way.

This avoids committing large binaries.

## Naming + commit hygiene

- Kebab-case, page-mirrored names (`session-detail-context.png`).
- Replace files in place. Never `session-list-v2.png` — README links break.
- Screenshots: PNG only. Hero: MP4 or GIF only. No mixed WebP unless the user opts in.
- Commit screenshots and the README change in the same commit.

## Alt text

One descriptive sentence per image, ~120 chars, describing what's literally on screen. Match the existing examples in the README — see lines 43, 47, 51, 55 of the current file.
