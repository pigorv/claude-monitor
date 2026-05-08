# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New "Invocations" column on the Session List shows the slash commands and skills used in each session as pills, matching the Timeline styling. Truncates to three pills with a `+N more` chip that expands inline. Aggregated at import time and stored on each session, so list paint stays a single index lookup.
- Sessions that *started* with a slash command or skill now show the same Timeline pill (blue `/command`, orange `skill: name`) inline before the summary text in the Session List, making it easy to scan for "the session I kicked off with `/review`".

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
