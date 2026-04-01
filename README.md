# claude-monitor

> Local observability dashboard for Claude Code sessions — see what your context window is actually doing.

[![CI](https://github.com/pigorv/claude-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/pigorv/claude-monitor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pigorv/claude-monitor)](https://www.npmjs.com/package/@pigorv/claude-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

## Why?

Claude Code sessions generate rich transcript data, but you can't see what's happening under the hood:

- **Context fills up silently** — you don't know you're at 90% until output quality drops. claude-monitor shows token utilization over time with warning and danger zones.
- **Compactions degrade quality** — when Claude compresses its context, reasoning can drift. claude-monitor scores each session's risk (0.0-1.0) based on compaction count, post-compaction drift, and 3 other signals.
- **Sub-agent calls are opaque** — spawned agents consume tokens and return results you never see. claude-monitor maps the full agent tree with prompts, results, and per-agent token costs.

## Quick Start

```bash
npx @pigorv/claude-monitor start
```

This imports transcripts from `~/.claude/projects/`, starts the dashboard at `http://localhost:4173`, and opens your browser.

To import transcripts without starting the server:

```bash
npx @pigorv/claude-monitor import ~/.claude/projects/
```

**Requirements:** Node.js >= 20, Claude Code (for transcript files)

## Features

**Context Pressure** — Interactive token chart (uPlot) with input/output/cache breakdown, model-specific thresholds, compaction markers, and drag-to-zoom.

**Thinking Inspection** — Expandable thinking blocks in the event timeline. See exactly where Claude's reasoning chain took a wrong turn.

**Agent Tree** — Parent-child agent relationships with per-agent metrics: duration, token usage, compression ratio, and result classification.

**Risk Scoring** — Composite 0.0-1.0 score from 5 weighted signals: context utilization (30%), compaction count (25%), post-compaction drift (20%), long tool output (15%), deep nesting (10%).

**Session List** — Filterable, sortable table with model filter chips, search, sparkline previews, and color-coded compaction counts.

## How It Works

The `start` command watches `~/.claude/projects/` for JSONL transcript files. Each transcript is parsed into thinking blocks, tool calls, token snapshots, and compaction events, then stored in a local SQLite database (`~/.claude-monitor/data.sqlite`). The dashboard reads from this database — no data leaves your machine.

## CLI Reference

| Command | Description |
|---------|-------------|
| `claude-monitor start` | Start dashboard + auto-import (default port: 4173) |
| `claude-monitor import <path>` | One-time import of transcripts |
| `claude-monitor status` | Show database stats and server status |

Options for `start`: `--port, -p <number>`, `--no-open`, `--db <path>`, `--verbose`

Options for `import`: `--force` (re-import existing sessions)

## Built With

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Preact](https://img.shields.io/badge/Preact-HTM-673AB8?logo=preact&logoColor=white)](https://preactjs.com/)
[![Hono](https://img.shields.io/badge/Hono-server-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![uPlot](https://img.shields.io/badge/uPlot-charts-4C566A)](https://github.com/leeoniya/uPlot)

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

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and conventions.

## License

[MIT](./LICENSE)
