# Contributing to claude-monitor

## Development Setup

```bash
git clone https://github.com/pigorv/claude-monitor.git
cd claude-monitor
npm install
npm run build
```

## Project Structure

```
src/
  cli/          # CLI entry point and commands (import, start, status)
  server/       # Hono HTTP server, routes, middleware
  ingestion/    # JSONL parser, transcript importer, thinking extractor, token tracker
  analysis/     # Context pressure scoring, risk heuristics, session summary
  shared/       # Types, constants, logger
  db/           # SQLite schema, connection, migrations, queries
frontend/       # Preact + HTM dashboard (built with Vite)
test/           # Tests and fixtures
```

## Development Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Build CLI + frontend |
| `npm run dev` | Start server in dev mode with auto-reload |
| `npm run dev:frontend` | Start Vite dev server for frontend |
| `npm test` | Run test suite |
| `npm run typecheck` | TypeScript type checking |

## Key Conventions

- **Dependencies**: Keep minimal.
- **Database**: Uses synchronous better-sqlite3 API with WAL mode. All timestamps are ISO 8601 strings.
- **Frontend**: Uses Preact with HTM tagged templates — no JSX transform needed. Styles are plain CSS with custom properties (dark theme).
- **Errors**: Should be actionable. Tell the user what to do, not just what failed.
- **Imports**: Use `node:` prefix for built-in modules.

## Running Tests

Tests use Vitest:

```bash
npm test
```

Test files are in `test/` and follow the pattern `*.test.ts`. Fixtures are in `test/fixtures/`.

## Architecture

See `CLAUDE.md` for architecture details covering the ingestion pipeline, database schema, API routes, and analysis engine.
