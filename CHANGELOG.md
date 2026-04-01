# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
