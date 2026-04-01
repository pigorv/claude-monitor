# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Local observability dashboard for Claude Code sessions. Imports JSONL transcript files from `~/.claude/projects/`, analyzes context pressure and risk, and serves a Preact SPA dashboard.

## Tech Stack

- **Runtime:** Node.js >= 20, TypeScript (strict mode, ESM)
- **Server:** Hono with `@hono/node-server`
- **Database:** better-sqlite3 (WAL mode, synchronous API)
- **Frontend:** Preact + HTM tagged templates (no JSX transform), uPlot for charts
- **Build:** tsup (CLI → `dist/index.js`) + Vite (frontend → `dist/frontend/`)
- **Tests:** Vitest
- **Package manager:** npm

## Commands

```bash
npm run build          # Build CLI (tsup) + frontend (Vite)
npm run dev            # tsup --watch (rebuilds CLI on change)
npm run dev:frontend   # Vite dev server (proxies /api → localhost:4173)
npm test               # vitest run
npm run typecheck      # tsc --noEmit
```

Run a single test file:
```bash
npx vitest run test/ingestion/thinking-extractor.test.ts
```

## Architecture

### Data Flow

```
JSONL transcript → jsonl-parser → thinking-extractor → token-tracker → risk-scoring → SQLite
                                                                                        ↓
                                                            Preact SPA ← Hono API ← queries/
```

### Ingestion Pipeline (`src/ingestion/`)

1. **jsonl-parser** — streaming async generator, reads JSONL line-by-line, normalizes content blocks, extracts usage info
2. **thinking-extractor** — converts messages to typed `ParsedEvent[]` (thinking, tool calls, messages); merges tool_use start/end pairs; assigns agent IDs from tool names
3. **token-tracker** — builds ordered `TokenSnapshot[]` from assistant messages; detects compaction (>30% input token drop); computes context utilization % against model thresholds
4. **transcript-importer** — orchestrates the full pipeline; handles subagent files (in `/subagents/` paths) as child events; idempotent (skips existing unless `--force`)
5. **session-linker** — detects plan→implementation session pairs via `ExitPlanMode` tool calls
6. **transcript-watcher** — polls `~/.claude/projects/` every 5s for new/modified transcripts

### Analysis Engine (`src/analysis/`)

Risk scoring produces a 0.0–1.0 composite score from 5 weighted signals: context utilization (30%), compaction count (25%), post-compaction drift (20%), long tool output (15%), deep nesting (10%).

### Server (`src/server/`)

Hono app with routes: `/api/health`, `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/events`, `/api/stats`, `/api/reimport`, `/api/export`. Static files served with SPA fallback.

### Database (`src/db/`)

- **connection.ts** — singleton with prepared statement caching and WAL pragmas
- **schema.ts** — tables: `sessions` (24 cols), `events`, `agent_relationships`, `session_links`
- **migrations.ts** — 7 sequential migrations
- **queries/** — batch queries to avoid N+1; statement caching for hot paths

### Frontend (`frontend/src/`)

Hash-based SPA routing. Pages: SessionList (filterable/sortable table), SessionDetail (Timeline/Context/Agents tabs), Settings. API client in `frontend/src/api/client.ts`.

## Conventions

- Keep dependencies minimal — check architecture doc before adding any new dep
- Database operations use synchronous better-sqlite3 API
- Frontend uses HTM tagged templates (no JSX transform needed)
- Error messages should be actionable — tell the user what to do, not just what failed

## Changelog

When making bug fixes or adding features, add a bullet under the `## [Unreleased]` section in `CHANGELOG.md` using the appropriate subsection (`Added`, `Changed`, `Fixed`, `Removed`). Keep entries concise — one line per change, written from the user's perspective.
- Keep dependencies minimal
- Database operations are synchronous (better-sqlite3 API)
- Frontend uses HTM tagged templates: `` html`<div>...</div>` `` — no JSX
- Use `node:` prefix for Node.js built-in imports
- All timestamps are ISO 8601 strings
- Frontend styles are plain CSS with custom properties (dark theme)
- `better-sqlite3` is marked external in tsup (native module)
- Vite dev server proxies `/api` to `localhost:4173` — run both `npm run dev` and `npm run dev:frontend` for full local development
