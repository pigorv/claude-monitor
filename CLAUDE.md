# claude-monitor

Local observability dashboard for Claude Code sessions.

## Tech Stack

- **Runtime:** Node.js >= 20, TypeScript (strict)
- **Server:** Hono
- **Database:** better-sqlite3 (WAL mode)
- **Frontend:** Preact + HTM, uPlot for charts
- **Bundler:** tsup (lib/CLI) + Vite (frontend)
- **Package manager:** npm

## Project Structure

```
src/
  cli/          # CLI entry point and commands (import, start, status, setup)
  server/       # Hono HTTP server, routes, middleware
  ingestion/    # JSONL parser, hook handler, transcript importer, file watcher
  analysis/     # Context pressure scoring, risk heuristics, session summary
  shared/       # Types, constants, logger
  frontend/     # Preact app, pages, components
  db/           # SQLite schema, connection, migrations, queries
hooks/          # capture.mjs — standalone hook script invoked by Claude Code
test/           # Tests and fixtures
```

## Development Commands

```bash
npm install          # Install dependencies
npm run build        # Build CLI + frontend
npm run dev          # Start server in dev mode
npm run dev:frontend # Start Vite dev server
npm test             # Run tests
```

## Conventions

- Keep dependencies minimal — check architecture doc before adding any new dep
- All hooks must run with `async: true` and complete in < 50ms
- Database operations use synchronous better-sqlite3 API
- Frontend uses HTM tagged templates (no JSX transform needed)
- Error messages should be actionable — tell the user what to do, not just what failed
