# claude-monitor

> Local observability dashboard for Claude Code sessions — see what your context window is actually doing.

[![CI](https://github.com/pigorv/claude-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/pigorv/claude-monitor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pigorv/claude-monitor)](https://www.npmjs.com/package/@pigorv/claude-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

<!-- hero:start -->
<!-- hero captured-on: v0.3.2 -->
<p align="center">
  <img src="docs/images/hero.gif" alt="claude-monitor walkthrough — session list with project filter and Health strip, then session detail showing the Open in Terminal button, context chart with compaction markers, and a 5-agent Gantt timeline" style="max-width: 100%;" />
</p>
<!-- hero:end -->

## Why?

Claude Code sessions generate rich transcript data, but you can't see what's happening under the hood:

- **Context fills up silently** — you don't know you're at 90% until output quality drops. claude-monitor shows token utilization over time with warning and danger zones.
- **Files bloat your context** — every file read burns tokens, and re-reads of the same file waste context you can't afford. claude-monitor tracks which files were loaded, how many times, and how much context each one consumed.
- **Sub-agent calls are opaque** — spawned agents consume tokens and return results you never see. claude-monitor maps the full agent tree with per-agent token costs, Gantt timelines, tool breakdowns, and result classification.
- **Compactions are invisible** — when Claude compresses its context, you lose information silently. claude-monitor marks every compaction on the timeline so you can see exactly when and how much was lost.

<!-- quickstart:start -->
## Quick Start

First, import every existing Claude Code session from `~/.claude/projects/`:

```bash
npx @pigorv/claude-monitor import ~/.claude/projects/
```

Then start the dashboard — it opens at `http://localhost:4173` and tracks only newly added sessions going forward:

```bash
npx @pigorv/claude-monitor start
```

**Requirements:** Node.js >= 20, Claude Code (for transcript files)
<!-- quickstart:end -->

<!-- features:start -->
## Features

**Session List** — Filterable, sortable table with model filter chips, a project folder filter with session counts, Sonnet→Opus multi-model pills, search, infinite scroll with a sticky header, and a Health strip on every row showing context %, peak tokens against a 1M reference, and compaction dots.

<img src="docs/images/session-list.png" alt="Session list across 4 projects with project filter chips, multi-model pills (Sonnet→Opus, Opus→Sonnet), and Health strips showing context %, peak tokens, and compaction dots" width="700" />

**Context Pressure** — Interactive token chart (uPlot) with input/output/cache breakdown, model-specific thresholds, compaction markers, and drag-to-zoom.

<img src="docs/images/session-detail-context.png" alt="Session detail page with header stats and a one-click Open in Terminal button, plus a context utilization chart showing two compaction drops and warning/danger threshold zones" width="700" />

**Thinking Inspection** — Expandable thinking blocks in the event timeline, with infinite scroll across long sessions. See exactly where Claude's reasoning chain took a wrong turn.

<img src="docs/images/session-detail-timeline.png" alt="Timeline tab showing chronological event cards with tool calls, a compaction marker, and a token budget bar at 67% — plus the always-visible Open in Terminal button on the session header" width="700" />

**Agent Tree** — Full sub-agent visibility with Gantt timeline, per-agent token costs, tool call breakdowns, compression ratios, and result classification. See which agents ran in parallel, which ones failed, and how much context each one consumed.

<img src="docs/images/session-detail-agents.png" alt="Agent concurrency Gantt with 5 sub-agents, per-agent token counts, tool call counts, and completed status badges, plus a one-click Open in Terminal button" width="700" />

**File Tracking** — See every file loaded into context, how many times it was re-read, and how many tokens each file consumed. Spot wasteful re-reads and files that bloat your context window.

**Resume in Terminal** (macOS) — One click opens Terminal.app or iTerm2 in the session's project folder and runs `claude --resume <id>`. Pick your preferred app in Settings.

**Shareable URLs** — Filters, search, sort, project selection, the active session-detail tab, and the selected agent are all reflected in the URL. Reload preserves the view, links are shareable, and back/forward cycle through tabs naturally.
<!-- features:end -->

## How It Works

The `start` command watches `~/.claude/projects/` for JSONL transcript files. Each transcript is parsed into thinking blocks, tool calls, token snapshots, and compaction events, then stored in a local SQLite database (`~/.claude-monitor/data.sqlite`). The dashboard reads from this database — no data leaves your machine.

<!-- cli:start -->
## CLI Reference

| Command | Description |
|---------|-------------|
| `claude-monitor start` | Start dashboard + auto-import (default port: 4173) |
| `claude-monitor import [path]` | One-time import of transcripts (defaults to `~/.claude/projects/`) |
| `claude-monitor status` | Show database stats and server status |

Options for `start`: `--port, -p <number>`, `--no-open`, `--verbose`

Options for `import`: `--force` (re-import existing sessions)
<!-- cli:end -->

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
