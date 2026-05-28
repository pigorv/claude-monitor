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
  analysis/     # Compaction detection, session summary, agent efficiency, session linking
  shared/       # Types, constants, logger
  db/           # SQLite schema, connection, migrations, queries
frontend/       # Preact + HTM dashboard (built with Vite)
test/           # Tests and fixtures
```

## Development Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Build CLI + frontend (one-time, required before `dev:server`) |
| `npm run dev` | Rebuild CLI on change (`tsup --watch`) — does not run a server |
| `npm run dev:server` | Run the rebuilt server on `:4173` (`node --watch`, restarts on `dist/index.js` change) |
| `npm run dev:frontend` | Vite dev server on `:5173` with HMR (proxies `/api` → `:4173`; requires `dev:server`) |
| `npm test` | Run test suite |
| `npm run typecheck` | TypeScript type checking |

For backend-only iteration, run `dev` + `dev:server` and open `http://localhost:4173`. Add `dev:frontend` and switch to `:5173` only when you want frontend HMR.

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
