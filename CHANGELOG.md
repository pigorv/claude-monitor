# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- API contract/snapshot tests now guard the response shape of every server route — including the binary `GET /api/export` and `GET /api/sessions/:id/export` endpoints (fingerprinted by their headers) — so an accidental change to what the API returns to the dashboard is caught in CI.
- Added Sonnet 5 (`claude-sonnet-5`) model support: sessions are now priced at Sonnet 5 rates, measured against its 1M context window, and get the 1M compaction/warning/danger lines plus a "Sonnet 5" label with the 1M badge.
- Export a single session as a sanitized, shareable, re-importable bundle — via the `claude-monitor export <session-id>` CLI command or the `GET /api/sessions/:id/export` endpoint — with all paths and content pseudonymized or scrambled while the structure (timeline, token curve, compaction, agent tree) is preserved.
- Export a session's raw, unsanitized transcripts as a verbatim byte-for-byte bundle — via `claude-monitor export <session-id> --raw` (`--no-sanitize`) or `GET /api/sessions/:id/export?sanitize=false` — for sharing with people you trust with the original paths and content; the bundle carries an `export-manifest.json` marking it unsanitized.
- Model labels now show the version alongside the family (e.g. "Sonnet 4.6", "Opus 4.8"), and a teal "1M" badge marks the 1M-context Sonnet variant so it's distinguishable from the standard 200K Sonnet.
- Added `docs/TESTING.md`, a living test-strategy document covering the L0–L6 testing pyramid, quality gates, coverage targets, and the fixture-corpus taxonomy — linked from the README and CONTRIBUTING guides.
- Test coverage is now measured with Vitest's v8 provider (`npm run coverage`) and gated in CI: global thresholds plus per-file ≥95% line coverage on the correctness-critical ingestion/db modules, with the coverage report uploaded as a build artifact and summarized on each run.
- The test suite is split into `unit` and `integration` Vitest projects, runnable via `npm run test:unit` and `npm run test:integration`; `npm test` and `npm run coverage` still run the full suite.
- A golden JSONL fixture corpus under `test/fixtures/` (happy-path, legacy-format, corrupt, plan/impl-pair, large, compaction, and subagent cases) documented in `test/fixtures/README.md`, with a PII gate (`test/fixtures/pii-gate.test.ts`) that fails the build if any fixture leaks a real path, email, or machine identifier; real-session fixtures are re-derivable through the sanitizer via `scripts/derive-fixture.mts`.
- Consumer specs (`test/fixtures/corpus-consumers.test.ts`) exercise each fixture taxonomy through the real pipeline — corrupt/legacy parsing, compaction detection, subagent attribution, and plan→implementation linking — so the corpus is verified behavior, not just inert data.
- A schema-drift canary (`test/fixtures/schema-drift-canary.test.ts`) scans the fixture corpus against a manifest of known JSONL fields (`src/ingestion/jsonl-schema-manifest.ts`) and surfaces any unrecognized message/usage/content field — a warning during `npm test`, with a strict `npm run test:schema-drift` for a hard local check — so an unaccounted-for Claude Code transcript field is flagged instead of silently dropped.

### Changed

- `npm run typecheck` now also typechecks the `scripts/` dev tools (e.g. `scripts/derive-fixture.mts`), so a `src/` signature change that breaks fixture re-derivation is caught in CI.
- CI now runs as separate, named jobs (typecheck, build, unit, integration, coverage) so a failing check is attributable at a glance; a new nightly scheduled workflow runs the full suite, and releases are gated behind a quality-gate job that must pass before `npm publish`.

### Fixed

- The synthetic zero-usage assistant message Claude Code writes at session end no longer stamps a `context_pct = 0` row onto the real user message it shares a timestamp with; the importer now skips enriching zero-effective-context, zero-output messages at the source.
- The session-list sparkline no longer shows a phantom drop to 0% at the end of a session or ~3× too many points; the batch mini-timeline now applies the same filtering and streamed-duplicate collapse as the session-detail chart, and existing databases are corrected at read time without a reimport.
- Compaction turns are now recorded as dedicated `compaction` events at import time so the timeline and mini-timeline reliably flag where auto-compaction occurred (existing databases need a force reimport to backfill these events). The importer persists the pre-drop context in event metadata so the compaction-details table reports the true tokens lost and the banner shows the pre-compaction pressure; compacted turns with no text block (tool-only) still get a marker.
- Agent efficiency metrics (peak context, compression ratio, compaction count) now populate for subagent-file-backed agents instead of always showing empty/NULL, and the peak is measured against the effective cached context rather than the tiny uncached input.
- Failed `Agent`/`Task` spawns (e.g. an unknown `subagent_type` that errors instantly) are now recorded with status `failed` instead of a phantom `completed` subagent — they no longer inflate the session's subagent count, and the agent-efficiency aggregate excludes them so a failed spawn no longer trips the "2+ agents" gate or skews the averages, token totals, or peak-concurrency figures.
- Sessions running a 1M-context model variant (a model id tagged `[1m]`) now compute context utilization against 1,000,000 tokens instead of the base model's 200K window.
- The 1M-context Sonnet variant now uses the 1M auto-compaction/warning/danger thresholds (matching Opus/Fable) instead of the 200K Sonnet's, so the chart's compaction line and budget ticks land in the right place.
- Subagents whose events live in a separate transcript file no longer collapse to a zero-length interval: an agent's end time is now derived from its reported `duration_ms`, so gantt bars, execution-mode inference, and peak-concurrency reflect the agent's real runtime (existing databases need a force reimport to backfill).

### Removed

- The Timeline toolbar no longer shows a standalone "N events" count; each filter pill already displays its own per-type count.

## [0.6.0] - 2026-06-19

### Added

- The session detail API now exposes a `token_budget` breakdown (billed tokens, total cost, parent vs. sub-agent split, per-token-type usage, and peak context) for each session. Cost fields are `null` for sessions with no priceable model, matching the session list's unpriced behavior.
- The transcript parser now captures the `cache_creation` 5-minute / 1-hour split alongside the authoritative total cache-write token count.
- Imports now persist the per-session cache-write 5m/1h split (and billed input tokens), plus per-subagent cache read/write totals, so cache usage is available throughout the dashboard.
- Imports now persist each sub-agent's own model on its agent relationship, so a sub-agent running on a different model than its parent can be identified.
- Each session now stores a full cost estimate (parent plus every sub-agent, each priced at its own model, including cache reads/writes), computed at import time.
- Sessions imported before the cost feature are backfilled with a cost estimate on upgrade — computed from their already-stored token totals — so the Session List shows cost across your whole history without a re-import, including sessions whose original transcripts have since been deleted. (Sessions with no recorded model remain uncosted.) Backfilled costs are a floor for the oldest sessions: those predating the billed-input/cache-split columns omit their fresh-input cost, and backfilled sub-agents are priced at the parent model rather than their own. A forced re-import refines both where the transcript still exists.

### Changed

- Context-window sizes (used for context utilization %, the chart's window label, and the "1M" badge) are now sourced from a single model-facts table (models.json) instead of being duplicated in the threshold config; resolved window values are unchanged.
- Session Detail now shows a single Token Budget summary bar (cost and peak-context halves) above the tabs, replacing the five-card stat grid.
- The Token Budget summary bar's cost box now expands into a breakdown panel — billed tokens and estimated cost, a parent-vs-sub-agents split (with run count), and a by-token-type breakdown (input, output, cache read, cache write 5m/1h) showing tokens and cost per segment. The expanded/collapsed state is remembered in the URL, so it survives tab switches, reloads, and shared links.
- The token budget breakdown panel now hides empty sections: the parent-vs-sub-agents split only appears when the session actually ran sub-agents, and the by-token-type legend omits token types with zero usage.

### Removed

- The Session Detail header no longer shows a redundant token count; the Token Budget summary bar and breakdown panel below it now own token reporting.
- The Timeline tab no longer shows the parent-vs-sub-agent token bar; the token budget breakdown now lives in the expandable summary above the tabs.

## [0.5.2] - 2026-06-17

### Added

- The Settings page now shows live re-import progress (processed of total plus a phase label — "Importing transcripts…" or "Compacting database…") while a run is in flight, and reattaches to an already-running re-import if you reload the page mid-run.
- A `GET /api/reimport/status` endpoint reports the progress of the current or most recent re-import (`{ total, processed, imported, errors, done }` plus the current phase).

### Changed

- Re-importing now runs in the background: the Settings "Re-import" button and `POST /api/reimport` return immediately, so the dashboard and other API calls stay responsive instead of freezing during a run — and starting a second re-import while one is in progress is rejected (409) rather than launching a parallel run.
- The database is now compacted automatically after a re-import completes — the full-text search index is consolidated (FTS5 `optimize`) and then the file is `VACUUM`ed — reclaiming the disk space left behind by the re-import churn. (VACUUM alone did not consolidate the search index, so the database still grew on each re-import; it now stays at a stable size.)
- The Agents tab now labels a subagent's token totals "Input"/"Output" instead of "Prompt"/"Result", reflecting that they are the summed non-cached input/output tokens across the subagent's API calls.
- Re-importing an unchanged subagent transcript is now skipped without re-parsing or rewriting the database, by comparing the file's modification time against the value stored at last import.
- Batch imports (including Reimport in Settings and `POST /api/reimport`) no longer process a subagent transcript twice when its parent transcript is in the same batch — the parent's import already covers it.
- Re-scans over an unchanged corpus are faster: an already-imported session is now recognized straight from its transcript filename without reading the file body, and each transcript that does need parsing is read only once (the session title is now extracted in the same pass).

### Fixed

- Subagent and parent-session token totals are no longer inflated by streamed duplicate JSONL lines (same message counted multiple times); only the final cumulative usage per message is summed. Pre-existing rows recompute on a force Reimport.
- Context chart no longer shows duplicated points for streamed assistant messages, and event markers now align with the tool calls they describe.
- Re-importing transcripts no longer slows down quadratically on large corpora. A dead self-referencing column on the events table forced a full table scan on every event delete during re-import; it has been removed.
- Session titles now import from modern `ai-title` transcript records (not just the legacy `custom-title` format), so AI-generated titles appear again. A manual rename still takes precedence over the AI title.
- When no AI title exists, the session title falls back to the first meaningful user message — plain text or a slash command, whichever came first — and reset commands like `/clear` and `/compact` can never become the title.
- Synthetic transcript messages (system reminders, task notifications, skill expansions, interrupt markers) can no longer become the session title.
- The session-list "started with" pill skips reset commands (`/clear`, `/compact`) and shows the first meaningful command or skill instead, so sessions opened with `/clear` no longer display a `/clear` pill.
- Skill badges in the session list no longer duplicate the "started with" pill — whether the session started with the skill directly or via its same-named slash command.

## [0.5.1] - 2026-06-10

### Added

- Support for the **Fable 5** model (`claude-fable-5`). Fable sessions are now measured against their 1M-token context window (correct context-pressure % and chart threshold lines), show a cost estimate ($10/$50 per MTok) in the session list and `/api/stats` totals, render a styled **Fable** pill with a 1M badge, and can be isolated with a Fable model filter. Fable sessions imported before this version were measured against a 200K window — use Reimport in Settings (or `POST /api/reimport`) to recompute them.

### Changed

- README: added a Contents table of contents and folded the Status line, Uninstall, and Development sections into collapsible `<details>` for easier scanning.

### Fixed

- The watcher now imports sessions that were created or modified while claude-monitor was stopped, instead of silently skipping them until the next live edit. On startup it seeds from each session's last-imported transcript mtime (now persisted), so new-while-down sessions appear on first load and appended-while-down sessions update — while unchanged sessions are still skipped without a full re-parse.

## [0.5.0] - 2026-06-07

### Added

- Session List search now matches **message content**, not just session metadata. Typing in the search box finds sessions by what was actually said in them (user prompts and assistant replies), in addition to project name, path, and summary. Matches are ranked by where the hit landed — session title / first prompt first, then your other prompts, then assistant replies, and finally sub-agent turns last — and a content match shows a "matched in prompt / response / sub-agent" chip plus a highlighted snippet so it's clear why the session surfaced. Backed by a SQLite FTS5 index, so it stays fast as transcripts grow, and existing sessions are searchable immediately after upgrading (no reimport needed).
- README: new **Status line link** section showing how to add a clickable `🔗 monitor` link to your Claude Code status line that deep-links to the current session in the dashboard. Covers a from-scratch setup for users new to status lines, a drop-in snippet for those who already have one, and the option to just ask Claude Code to wire it up — all using the live `session_id` Claude Code provides and an OSC 8 hyperlink (iTerm2/Kitty/WezTerm). Port overridable via `CLAUDE_MONITOR_PORT`.
- Design-system token guard (`npm run lint:tokens`) and a `design-system` steward skill that keep future UI changes on the shared color palette. The guard now also flags raw hex written as a string literal anywhere in a component (e.g. a color returned from a helper), not only on `style=` lines.

### Changed

- Unified all dashboard colors onto a single three-tier design-token system (five semantic color ramps, each owning one meaning) for consistent styling across every tab and view.
- Session Detail timeline: the event-type filter (All / User / Assistant / Tools) is restyled to match the Timeline/Agents tab badges — each pill now carries a per-type event count, and the selected filter reads as a soft purple-tinted pill with a leading check instead of a heavy solid-purple fill. Counts are parent-only for sessions with sub-agents, matching the rows the timeline actually renders. The filter row also gets a little breathing room below the tab strip.

### Fixed

- Context chart colors now match across each element: the Context % line and the area fill beneath it share one purple, the Cache-read legend swatch matches the line it labels, and the compaction marker's pill, legend, and line all use the same red. Previously the canvas migration left the line/fill/legend variants on slightly different shades.
- Edit tool tags now render purple (previously green); Gantt bars now distinguish running (purple) from completed (teal); the session-list context-% badge uses consistent teal/amber/red thresholds at 40% / 65%.
- Session Detail → Agents: the "Agent concurrency" Gantt chart is now readable for long (multi-hour) sessions. The time axis no longer explodes into a wall of one-minute tick labels — it shows at most ~8 hour-aware ticks (e.g. `+22h 57m`) regardless of session length. Bars are framed to the agent-activity window (first agent start → last agent end) instead of the full session span, so short sub-agents in a 24h session are spread out and visible rather than crushed into 2px specks at the same spot. Durations across the Agents tab now render in `Hh Mm` form for long spans.
- Session Detail: the `Timeline (N)` tab badge no longer overcounts for sessions with sub-agents, and the Timeline's "N events" toolbar count now stays parent-only under every filter (User / Assistant / Tools), not just "All". Both report the parent-only event count — matching the rows the Timeline actually renders — instead of silently including every sub-agent's internal events.

## [0.4.1] - 2026-05-30

### Added

- Windows support for the "Open in Terminal" button on session pages. Auto-detect prefers Windows Terminal (`wt.exe`), then PowerShell, then `cmd.exe`; each launches a new window at the session's project directory with `claude --resume <id>` already running. `/api/health` now reports `platform`.
- README: new **Uninstall** section documenting the full cleanup procedure — stop running instances, delete `~/.claude-monitor/`, and (if installed globally) `npm uninstall -g @pigorv/claude-monitor`. Calls out that `~/.claude/projects/` belongs to Claude Code and should not be deleted.
- Session Detail timeline: `AskUserQuestion` tool calls now render as a review-mode card with three zoom levels. **L1 — collapsed row:** purple `AskUserQuestion` badge, `N questions` chip, the first question (truncated), and a small uppercase `rejected` / `error` tag sourced from `metadata.permission_status` / `metadata.tool_error` when applicable. **L2 — expanded card** (white background, accent left-rail): each question listed as `Q1/Q2/…` (counter omitted when there's only one) with a `→ <selected option>` line below in monospace; questions with no recorded answer render silently. A small `custom` tag annotates lines where the user typed text instead of picking from offered options. **L3 — per-question expansion:** click any question's chevron to reveal the full options grid for that one question only (other questions stay in L2). Selected options carry the accent rail + tint + check icon; alternatives mute to gray. Each question header has a hover-revealed Copy button that puts a formatted `Q / Options / A` block on the clipboard. Multi-select questions show a `multi-select` tag. Renders only what the SDK actually wrote — no derived status pills, no editorial copy.
- `npm run dev:server` script: runs the rebuilt CLI's `start` command under `node --watch`, restarting on `dist/index.js` change. Pair with `npm run dev` for backend iteration without manually re-running the server.
- `npm run clean` script: removes the `dist/` directory for a full from-scratch rebuild.
- Session Detail timeline: each expanded message and tool body — and every Write/Edit card, including empty-content writes — has a hover-revealed Copy button that puts the full, untruncated text on the clipboard.

### Fixed

- "Open in Terminal" on Windows now rejects a project path containing a semicolon when launching via Windows Terminal (`wt.exe`), which would otherwise re-tokenize the path and run a stray subcommand. PowerShell and `cmd.exe` launches were already guarded.
- Install no longer fails on Node 24. Bumped `better-sqlite3` to v12, which ships prebuilt binaries for Node 24's ABI, so `npx @pigorv/claude-monitor` and `npm install -g` work on machines without a C++ toolchain (Python / VS Build Tools on Windows, Xcode CLT on macOS).
- Session Detail timeline: selecting text inside an expanded block no longer collapses it when you release the mouse. Drag-select-then-collapse fix now applies uniformly to thinking, assistant, user, system, and skill-expansion cards, and Copy buttons surface a "Failed" state instead of silently doing nothing when the clipboard API rejects (e.g. on non-secure origins).
- `npm run dev` (tsup `--watch`) no longer wipes the prebuilt frontend bundle at `dist/frontend/`. tsup's clean step is now scoped to its own outputs, so the Hono server can keep serving the SPA on `:4173` while CLI code is iterated on. Use `npm run clean` for a full rebuild.

### Changed

- Settings terminal-app dropdown is now platform-aware (macOS vs Windows options derived from `/api/health`). On platforms where "Open in Terminal" isn't supported, the per-session button is disabled with an explanatory tooltip instead of clicking through to a 400 error.
- Session Detail timeline: every expanded block — tool groups, system groups, and individual event panes — now has a consistent full-width "Collapse" button at its foot, replacing the small left-aligned text link. Write/Edit cards use the same full-width style for the "Show N more lines" expand control.

## [0.4.0] - 2026-05-19

### Added

- README hero GIF and all four feature screenshots recaptured with demo data; hero walkthrough updated to show Sort dropdown interaction and Write/Edit full-card diffs in the Timeline.

- Session List rows now show a right-rail telemetry ledger: relative-start → ended clock (full timestamps on hover), model pill, duration · estimated cost, and a peak-context / input / output / cache-hit line. Peak context % is color-coded against the model's context thresholds; cache hit turns amber below 50%.
- Session List groups rows under TODAY / YESTERDAY / THIS WEEK / date headers (with counts) when sorted by start time.
- Sort dropdown gains "Highest/Lowest ctx %" and "Most expensive/Cheapest" options.

### Fixed

- Session List no longer shows a spurious "0% ⚡" cache badge on sessions where caching was never used.
- Session Detail timeline: user messages no longer render with a double-nested box (a purple card wrapping a separate bordered inner body).

### Changed

- Session List redesigned around recognition: the task intent is now the bold row title with the project name demoted to a small label; turns, sub-agents, tools, skills, and compaction count are consolidated into one muted subtitle line. The dedicated Skills, Agents, and Health columns were removed.
- Session List filter controls consolidated into a single horizontal filter bar with Project, Model, and Sort dropdowns; result count badge pulses during loading; press `/` to focus search from anywhere on the page.
- Session Detail timeline: user and assistant messages now use a consistent, clearly distinguishable treatment. Both show an uppercase role label (`USER` purple, `ASSISTANT` gray) and a matching rail-dot color. Each message body is a single box with matching border/radius/size: the user message is a faint purple-tinted box (and purple `USER` label + rail dot) so the human's input pops, while the assistant message is a neutral white card (gray `ASSISTANT` label + dot) — the calm baseline, since every saturated tint in the timeline is already a semantic signal (green=Write, teal=agent, orange=skill, yellow=think, red=error). No more ambiguous, near-identical message styling or double-nested boxes. Long assistant replies fade out at the clip line instead of being hard-cut, signalling there's more on click.
- Session Detail timeline: Write and Edit tool calls now render as full cards with rationale, diff/content body, and per-card metadata (language · duration · output · cache). The rationale is sourced from the nearest preceding `thinking_summary` in the same assistant turn. User messages adopt a matching purple-accent card style; system-generated, slash-command, and skill-expansion paths are unchanged. Bodies are syntax-highlighted (Prism.js, curated grammar set) and collapse to ~10 lines by default with in-place expand.

## [0.3.5] - 2026-05-11

### Added

- New "Skills" column on the Session List shows skill names invoked in each session as pills (matching the Timeline styling). Truncates to three pills with a `+N more` chip that expands inline. Aggregated at import time and stored on each session, so list paint stays a single index lookup.
- Sessions that *started* with a slash command or skill now show the same Timeline pill (blue `/command`, orange skill name) inline before the summary text in the Session List, making it easy to scan for "the session I kicked off with `/review`".

### Changed

- Expanded skills list in the Session List can now be collapsed back: the `+N more` chip toggles to "Show less" while expanded.
- Event detail panes now render structured content rather than plain `<pre>` text: tool inputs are pretty-printed JSON, thinking and skill-expansion bodies render as markdown (bold, lists, headings, inline code), and `<system-reminder>` / `<example>` tags are shown as styled blocks with the tag visible as a label. Tool outputs auto-detect format. Applied uniformly across the main Timeline, sub-agent groups (`AgentGroup`), and the Agents tab (`AgentTree`), so the same content renders the same way regardless of where it appears. Assistant message rendering is unchanged.

### Fixed

- Session List "Agents" column was no longer center-aligned after the Skills column was inserted at position 2 (the positional `nth-child(4)` selector started hitting Duration). Centering now follows the Agents cell directly.
- Session List header labels in narrow sortable columns (Duration, Agents) appeared shifted up vs. the rest of the row. The sort-arrow placeholder (`th.sortable::after`) was wrapping below the label in narrow cells, doubling the line box. Headers stay on a single line now.

### Removed

- Risk scoring feature (composite session risk score and `risk_score` DB column). The score was never rendered in the UI; backend pipeline, API fields (`risk_score`, `risk_level`, `risk` on session detail, `avg_risk_score`/`high_risk_sessions` on stats, `min_risk` filter, `risk_score` sort), and the `context-pressure` analysis module are removed. Migration 011 drops the column from existing databases and clears any stale `risk_signals` blobs left in `sessions.metadata` by older imports.

## [0.3.4] - 2026-05-08

### Fixed

- README on npmjs.com no longer renders blank. Image references now use absolute `raw.githubusercontent.com` URLs instead of relative `docs/images/` paths, so npm's renderer no longer chokes on the hero GIF.

## [0.3.3] - 2026-05-08

### Changed

- Session List and Timeline now load more rows/events automatically as you scroll, replacing the Prev/Next pagination. The Session List header row stays sticky while scrolling, and a "↑ Top" button appears after scrolling past two viewports.
- Filters, search, sort, project selection, the active session-detail tab, and the selected agent on the Agents tab are now reflected in the URL hash. Reload preserves the view, the URL is shareable, and back/forward cycles between tabs (filter/sort/search/agent edits replace the history entry instead of pushing).
- Expanded GitHub issue and PR templates with pre-submit checklists, affected-area selectors, severity/regression questions, and an explicit data-discrepancy section in the bug template. Added CHANGELOG and Quick Start contact links to the issue chooser.
- Session list trailing column now renders a "Health" strip (context %, peak tokens vs. 1M, and up to three compaction dots) instead of the generic sparkline, surfacing context pressure and compaction activity at a glance.

### Added

- Favicon and web app manifest so the dashboard is identifiable in pinned tabs, bookmarks, and OS-level previews (stacked token-pressure bars in the brand purple).
- Cross-session preferences (default sort, default chip filter, default project, project sidebar expanded?) persist in localStorage under `cm.sessionList.*` keys. Existing `cm:projectFilter` is migrated automatically on first load. Session detail always opens on the Timeline tab — switching tabs still updates the URL for sharing/back-forward, but no preference is saved across sessions.
- "Clear filters" button on the session list resets URL params and saved localStorage defaults back to the factory state. Appears whenever any filter is active, regardless of whether it came from the URL or your saved preferences.

## [0.3.2] - 2026-05-01

### Added

- One-click "Open in Terminal" button on session detail pages (macOS). Opens Terminal.app or iTerm2, `cd`s into the session's project directory, and runs `claude --resume <id>` automatically. Preferred app is selectable in Settings (auto-detect / Terminal.app / iTerm2).

### Fixed

- Agent tab: "Result returned" section is now collapsed by default (matching "Prompt sent"), so agent details open compactly
- Context chart and session-list sparklines now include tool-only assistant turns. Previously turns that contained only `thinking` + `tool_use` (no text reply) were dropped, leaving agentic sessions with near-empty charts. The fix deduplicates token snapshots per turn by timestamp, so each assistant message contributes exactly one point regardless of content shape.

## [0.3.1] - 2026-04-17

### Fixed

- Peak Tokens stat on session detail now reflects effective context (input + cache read + cache write) instead of only the non-cached `input_tokens`, which was misleadingly small for cached sessions
- Agents tab no longer duplicates subagents — each Agent/Task call now produces a single row instead of two (one synthetic, one from the on-disk subagent file). Re-import affected sessions with `claude-monitor import --force` to collapse existing duplicates.

## [0.3.0] - 2026-04-17

### Removed

- Removed `watch` command (use `import` or `start` instead)

### Added

- Multi-model pills on session detail page — model transitions (e.g., "Sonnet → Opus") now appear in the detail header, matching the session list
- Project folder filter — chip bar above the session table lets you scope sessions to a specific project, with session counts and localStorage persistence
- Multi-model indicator in session list — sessions where the model was switched mid-session (e.g., via `/model`) now show a transition pill like "Sonnet → Opus"
- Hero GIF and feature screenshots in README showing session list, timeline, context chart, and agent tree
- Demo data seeding script (`npm run demo:seed`) and Playwright screenshot capture (`npm run demo:screenshots`)

### Fixed

- Session list now displays AI-generated session title instead of raw first user message
- Session labels now show the command name (e.g., `/commit`) instead of generic "Session" when a session starts with a slash command
- Model filter now matches multi-model sessions — filtering by any model used during a session (not just the primary) returns that session
- Agent tab: "Prompt Sent" and "Result returned" sections now display full content instead of truncated previews
- Agent tab: token impact bars now correctly scale to each tool call's share of context, with hover tooltips showing exact percentage (bars enlarged to 100×8px)

## [0.2.1] - 2026-04-02

### Changed

- Scoped npm package as `@pigorv/claude-monitor` and updated all repository URLs to `pigorv/claude-monitor`
- Release workflow uses npm Trusted Publishing (OIDC) instead of stored NPM_TOKEN secret
- Overhauled README with badges, "Why?" section, simplified quickstart, and landing-page structure
- Removed broken `claude-monitor-architecture.md` references from CLAUDE.md, CONTRIBUTING.md, and skill files

## [0.2.0] - 2026-04-01

### Fixed

- Migrated test suite from `node:test` to Vitest for reliable CI execution
- CI pipeline: pinned Node 22, fixed release workflow build order

### Changed

- Improved text contrast for WCAG AA compliance (`--text2`, `--text3` tokens)
- Added `:focus-visible` rings on buttons, chips, tabs, and pagination for keyboard navigation
- Tool badges now use distinct colors: Grep (indigo), Glob (teal), Edit (emerald) are visually distinguishable
- Bumped minimum font size from 9px to 10px across 15+ elements for better readability
- Extracted inline `color-mix()` calls into reusable `--*-tint` CSS custom properties
- Replaced hardcoded hex values with CSS variable references throughout session-detail styles
- Gave `.risk-pill.critical` a distinct heavier style to differentiate from `.risk-pill.high`
- Added phone breakpoint (480px) for single-column stat cards and narrower timeline
- Removed duplicate/contradictory tool badge definitions between globals.css and session-detail.css

## [0.1.0] - 2026-03-17

### Added

- CLI with `start`, `import`, and `status` commands
- Hono HTTP server with SQLite (WAL mode) persistence
- JSONL transcript ingestion with thinking extraction and token tracking
- Context pressure scoring and risk heuristics
- Preact + HTM frontend dashboard with uPlot charts
- Session list, timeline, and agent tree views
