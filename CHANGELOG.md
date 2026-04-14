# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project folder filter — chip bar above the session table lets you scope sessions to a specific project, with session counts and localStorage persistence
- Multi-model indicator in session list — sessions where the model was switched mid-session (e.g., via `/model`) now show a transition pill like "Sonnet → Opus"
- Hero GIF and feature screenshots in README showing session list, timeline, context chart, and agent tree
- Demo data seeding script (`npm run demo:seed`) and Playwright screenshot capture (`npm run demo:screenshots`)

### Fixed

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
