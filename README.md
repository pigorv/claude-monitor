# claude-monitor

Local observability dashboard for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Track context pressure, inspect thinking processes, and debug sub-agent orchestration — all running locally on your machine.

## What It Does

- **Context pressure visibility** — token utilization over time, compaction events, quality degradation zones
- **Thinking process inspection** — extract and display Claude's reasoning chain to identify where wrong assumptions entered
- **Sub-agent orchestration debugging** — visualize parent-child agent relationships, prompts, results, and token usage

## Quickstart

```bash
# Install globally (or use npx)
npm install -g claude-monitor

# Import existing transcripts and start the dashboard:
claude-monitor import ~/.claude/projects/
claude-monitor start
```

The dashboard opens at `http://localhost:4173`.

## Requirements

- Node.js >= 20
- Claude Code (for transcript files)

## CLI Commands

### `claude-monitor start`

Start the dashboard server and open the browser.

```
Options:
  --port, -p <number>   Port number (default: 4173)
  --no-open             Don't open browser automatically
  --db <path>           Custom database path (default: ~/.claude-monitor/data.sqlite)
  --verbose             Enable debug logging
```

### `claude-monitor import <path>`

Import existing JSONL transcript files or directories.

```bash
# Import a single transcript
claude-monitor import ~/.claude/projects/-Users-me-myproject/abc123.jsonl

# Import all transcripts in a directory
claude-monitor import ~/.claude/projects/

# Force re-import (overwrite existing)
claude-monitor import --force ~/.claude/projects/
```

### `claude-monitor status`

Show database stats and server status.

## Dashboard Views

### Session List

Filterable, sortable table of all imported sessions. Filter by date range, risk level, or status. Each row shows duration, token usage, context peak, compaction count, sub-agents, and risk score.

### Session Detail — Timeline

Chronological event stream with type-specific cards: thinking blocks (expandable), tool calls with input/output, assistant messages, and compaction markers. Filter by event type and toggle thinking block visibility.

### Session Detail — Context

Token utilization chart (uPlot) showing input/output/cache tokens over time. Model-specific threshold lines (warning, danger, auto-compact) with shaded zones. Vertical markers at compaction events. Drag to zoom.

### Session Detail — Agents

Tree view of sub-agent relationships. Each node shows agent ID, status, duration, token usage, and tool count. Expandable to see full prompt and result data.

### Settings

Database stats (size, session/event counts), and actions (re-import transcripts, export database).

## How It Works

**Transcript import**: The `import` command parses JSONL transcript files from `~/.claude/projects/`, extracting thinking blocks, tool calls, token progression, and compaction points. Everything is stored in a local SQLite database with WAL mode for concurrent reads/writes.

**Analysis**: Each session gets a risk score (0.0–1.0) computed from 5 weighted signals: context utilization, compaction count, post-compaction drift, long tool outputs, and deep nesting. Context pressure is scored against model-specific thresholds.

## Configuration

All data is stored locally in `~/.claude-monitor/`:

| File | Purpose |
|------|---------|
| `data.sqlite` | Session and event database |

## Architecture

- **Runtime**: Node.js, TypeScript (strict)
- **Server**: Hono (~14KB)
- **Database**: better-sqlite3 with WAL mode
- **Frontend**: Preact + HTM + uPlot
- **Build**: tsup (CLI/server) + Vite (frontend)

See [`claude-monitor-architecture.md`](./claude-monitor-architecture.md) for full architecture details.

## Development

```bash
git clone https://github.com/pigorv/claude-monitor.git
cd claude-monitor
npm install
npm run build          # Build CLI + frontend
npm run dev            # Start server in dev mode
npm run dev:frontend   # Start Vite dev server
npm test               # Run tests
npm run typecheck      # TypeScript type checking
```

## License

[MIT](./LICENSE)
