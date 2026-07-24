# claude-monitor

> Local observability dashboard for Claude Code sessions — see what your context window is actually doing.

[![CI](https://github.com/pigorv/claude-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/pigorv/claude-monitor/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@pigorv/claude-monitor)](https://www.npmjs.com/package/@pigorv/claude-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)

<!-- hero:start -->
<!-- hero captured-on: v0.7.1 -->
<p align="center">
  <img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/hero.gif" alt="claude-monitor walkthrough — session list with date-group headers and Sort dropdown, then a session detail page with the Token Budget summary bar above Timeline (Write/Edit full-cards), Context chart, and 5-agent Gantt tabs" style="max-width: 100%;" />
</p>
<!-- hero:end -->

## Contents

[Why?](#why) · [Quick Start](#quick-start) · [Features](#features) · [How It Works](#how-it-works) · [CLI Reference](#cli-reference) · [Configuration](#configuration) · [Run in a container](#run-in-a-container) · [Status line link](#status-line-link) · [Uninstall](#uninstall) · [Built With](#built-with) · [Development](#development)

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

**Session List** — Filterable, sortable table with a recognition-first row layout: task intent as the bold title, project name as a small label, and turns/sub-agents/tools/skills/compaction in a muted subtitle. Every row has a right-rail telemetry ledger showing relative-start → ended clock (full timestamps on hover), model pill showing the version alongside the family (e.g. "Sonnet 4.6", "Opus 4.8"), with a teal "1M" badge on the 1M-context variants (Fable 5, Sonnet 5, and the 1M Sonnet), duration · estimated cost, and peak-context % color-coded against the model's threshold. Rows group under TODAY / YESTERDAY / THIS WEEK headers when sorted by start time. Single filter bar with Project, Model, and Sort dropdowns (including "Highest/Lowest ctx %" and "Most expensive/Cheapest" options); press `/` to focus search from anywhere — and search matches **message content** (the actual prompts and replies, not just project, path, and summary), ranking hits by where they landed and tagging each with a "matched in prompt / response / sub-agent" chip plus a highlighted snippet. Sessions started with a `/command` or skill show the command/skill pill inline before the session title. Every row is a real link, so cmd/ctrl-click or middle-click opens the session's detail in a new browser tab.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-list.png" alt="Session list with recognition-first row layout: bold session titles with project name labels, right-rail telemetry ledger showing timestamps, model pills, duration and estimated cost, color-coded peak-context %, and TODAY / YESTERDAY date-group headers" width="700" />

**Token Budget** — Every session detail page leads with a Token Budget summary bar above the tabs: estimated cost and billed token count on one side, peak context % (color-coded against the model's threshold) on the other. Click the cost to expand a breakdown panel — a parent-vs-sub-agents split (with run count) and a by-token-type breakdown (input, output, cache read, cache write 5m/1h), each showing tokens and cost; empty sections are hidden (no sub-agent split for solo sessions, no zero-usage token types). Cost prices every sub-agent at its own model with cache reads and writes included, and is backfilled across your whole history, so older sessions show a cost without a re-import. The expanded/collapsed state is remembered in the URL.

**Context Pressure** — Interactive token chart (uPlot) with input/output/cache breakdown, model-specific thresholds (Fable 5 and Sonnet 5 sessions are measured against their full 1M-token context window), compaction markers, and drag-to-zoom.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-detail-context.png" alt="Session detail page leading with a Token Budget summary bar — cost and billed tokens beside a color-coded context-peak meter — above the Context tab's token utilization chart with warning and danger threshold zones" width="700" />

**Thinking Inspection** — Expandable thinking blocks in the event timeline with infinite scroll. User messages appear in faint purple with an uppercase `USER` label and matching rail dot; assistant messages in neutral white with an `ASSISTANT` label — visually distinct from each other and from tool-call color signals (green=Write, teal=agent, orange=skill). Write and Edit tool calls render as full cards with rationale sourced from the nearest thinking block, a syntax-highlighted diff or content body (Prism.js), and per-card metadata (language · duration · output · cache); collapsible to ~10 lines with in-place expand, with long replies fading at the clip line. Thinking, skill expansions, and tool inputs also render as structured markdown / pretty-printed JSON / labeled `<system-reminder>` blocks — the same way across the Timeline, Agents tab, and sub-agent groups. `AskUserQuestion` prompts render as review cards with three zoom levels, from a collapsed one-line summary up to the full options grid showing exactly which option you picked. Every expanded block has a hover-revealed Copy button that puts the full, untruncated text on the clipboard.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-detail-timeline.png" alt="Timeline tab with a purple USER card, Write full-card showing syntax-highlighted TypeScript code, Edit full-card with +/- diff lines, and a gray ASSISTANT card" width="700" />

**Agent Tree** — Full sub-agent visibility with Gantt timeline, per-agent token costs, tool call breakdowns, compression ratios, and result classification. See which agents ran in parallel, which ones failed, and how much context each one consumed.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-detail-agents.png" alt="Agent concurrency Gantt with 5 sub-agents, per-agent token counts, tool call counts, and completed status badges, plus a one-click Open in Terminal button" width="700" />

**File Tracking** — See every file loaded into context, how many times it was re-read, and how many tokens each file consumed. Spot wasteful re-reads and files that bloat your context window.

**Resume in Terminal** (macOS & Windows) — One click opens your terminal in the session's project folder with `claude --resume <id>` already running. macOS uses Terminal.app or iTerm2; Windows auto-detects Windows Terminal, then PowerShell, then `cmd.exe`. Pick your preferred app in Settings — the dropdown is platform-aware, and the button is disabled with a tooltip on unsupported platforms. If Claude Code's retention cleanup has deleted the session's transcript, the button gives way to an "Expired" pill — the session can no longer be resumed, but its imported data stays in claude-monitor.

**Session Export** — Export any session as a self-contained, re-importable bundle. The Session Detail Export button, top-right in the page header, opens a modal where you pick your format: **Sanitized** (recommended) scrambles every path and content beyond recognition — unreadable, but structurally intact and safe to share anywhere — or **Raw**, a verbatim bundle with real paths and content to share only with people you trust; picking one downloads it. The CLI (`claude-monitor export <id>`) defaults to sanitized, with `--raw` for the verbatim bundle. A sanitized bundle pseudonymizes or scrambles every path and message body while preserving the full structure — timeline, token curve, compaction, and agent tree — so it round-trips back through `import`.

**Clone Session** — Re-root a session into a different project directory and resume it there. The Clone button in the Session Detail header opens a modal where you pick a target folder (pre-filled with the recorded path); it copies the transcript under a fresh session id rooted in that folder and hands back a ready `claude --resume <id>`, an Open in Terminal button, and a link to the clone. Disabled on Expired sessions, whose raw transcript is no longer on disk to copy.

**Shareable URLs** — Filters, search, sort, project selection, the active session-detail tab, the selected agent, and the Token Budget breakdown's expanded state are all reflected in the URL. Reload preserves the view, links are shareable, and back/forward cycle through tabs naturally.

**Background Re-import** — Re-import every transcript from Settings without freezing the dashboard. The run happens in the background with a live progress bar — processed-of-total plus a phase label ("Importing transcripts…" then "Compacting database…") — and reattaches to an in-flight run if you reload the page mid-import. Starting a second re-import while one is running is rejected rather than launching a parallel pass, and the database is compacted automatically when the run finishes (search index consolidation + VACUUM) so repeated re-imports don't bloat the file on disk.
<!-- features:end -->

## How It Works

The `start` command watches `~/.claude/projects/` for JSONL transcript files. Each transcript is parsed into thinking blocks, tool calls, token snapshots, and compaction events, then stored in a local SQLite database (`~/.claude-monitor/data.sqlite`). The dashboard reads from this database — no data leaves your machine.

<!-- cli:start -->
## CLI Reference

| Command | Description |
|---------|-------------|
| `claude-monitor start` | Start dashboard + auto-import (default port: 4173) |
| `claude-monitor import [path]` | One-time import of transcripts (defaults to `~/.claude/projects/`) |
| `claude-monitor export <id>` | Export a single session as a sanitized, re-importable zip |
| `claude-monitor status` | Show database stats and server status |

Options for `start`: `--port, -p <number>`, `--no-open`, `--verbose`

Options for `import`: `--force` (re-import existing sessions)

Options for `export`: `--out <path>` (destination file or directory), `--raw` / `--no-sanitize` (verbatim, unsanitized bundle — do not share)
<!-- cli:end -->

## Configuration

claude-monitor reads its deployment settings from environment variables, so you can point it at non-default paths or run it as a service without editing code:

| Variable | Controls | Default |
|----------|----------|---------|
| `CLAUDE_MONITOR_PORT` | HTTP listen port | `4173` |
| `CLAUDE_MONITOR_HOST` | Bind address | *(unset — binds all interfaces)* |
| `CLAUDE_MONITOR_DB_PATH` | SQLite database file | `~/.claude-monitor/data.sqlite` |
| `CLAUDE_MONITOR_PROJECTS_PATH` | Transcript directory the watcher scans | `~/.claude/projects` |
| `CLAUDE_MONITOR_DATA_DIR` | Base data directory | `~/.claude-monitor` |

- **Port precedence:** the `--port` / `-p` flag wins over `CLAUDE_MONITOR_PORT`, which wins over the `4173` default.
- **Relative paths** in any of the path variables resolve against the current working directory.
- **Bind host:** by default the server binds all interfaces. Set `CLAUDE_MONITOR_HOST=127.0.0.1` to restrict it to loopback (localhost only).

## Run in a container

A multi-stage `Dockerfile` ships in the repo. No image is published — build it locally:

```bash
docker build -t claude-monitor .
```

Then run it, mounting your transcripts read-only and a volume for the database:

```bash
docker run --rm \
  -e CLAUDE_MONITOR_HOST=0.0.0.0 \
  -e CLAUDE_MONITOR_PROJECTS_PATH=/transcripts \
  -e CLAUDE_MONITOR_DB_PATH=/data/data.sqlite \
  -v "$HOME/.claude/projects:/transcripts:ro" \
  -v "claude-monitor-data:/data" \
  -p 127.0.0.1:4173:4173 \
  claude-monitor
```

Open `http://localhost:4173`. The image binds `0.0.0.0` inside the container so the published port can reach it; you control host exposure through the `-p` mapping — `127.0.0.1:4173:4173` keeps the dashboard on loopback.

## Status line link

<details>
<summary><b>Add a clickable 🔗 monitor link to your Claude Code status line</b> — requirements and three setup paths</summary>

Add a clickable **🔗 monitor** link to your Claude Code [status line](https://code.claude.com/docs/en/statusline) that opens the current session straight in the dashboard. Claude Code hands your status line command the live `session_id`, and that id is exactly what the dashboard routes on — so the link always points at the session you're in (`http://localhost:4173/#/session/<id>`).

**Requirements:** a terminal that renders OSC 8 hyperlinks (iTerm2, Kitty, WezTerm — not Apple Terminal; tmux/SSH may strip them), `jq`, and a running `claude-monitor start`. The port defaults to `4173`; override it with `CLAUDE_MONITOR_PORT` (see [Configuration](#configuration)).

### Set it up from scratch

No status line yet? This gets you one that shows just the link, in three steps.

1. **Install `jq`** if you don't have it — `brew install jq` (macOS), or your package manager.

2. **Create** `~/.claude/statusline.sh`:

   ```bash
   #!/usr/bin/env bash
   INPUT=$(cat)
   SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
   if [ -n "$SID" ]; then
     printf '\033]8;;http://localhost:%s/#/session/%s\a🔗 monitor\033]8;;\a\n' "${CLAUDE_MONITOR_PORT:-4173}" "$SID"
   fi
   ```

3. **Register it** in `~/.claude/settings.json` (create the file if it doesn't exist):

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "bash ~/.claude/statusline.sh"
     }
   }
   ```

Start a session with `claude-monitor start` running, then **Cmd+click** (macOS) / **Ctrl+click** the `🔗 monitor` chip — it opens that session in the dashboard. From here you can grow the script however you like (folder, git branch, tokens…).

### Already have a status line?

You know your own script — drop this block in wherever you want the link to sit (it assumes stdin is already captured, e.g. `INPUT=$(cat)`):

```bash
# clickable Claude Monitor link (OSC 8)
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
if [ -n "$SID" ]; then
  printf '  \033]8;;http://localhost:%s/#/session/%s\a🔗 monitor\033]8;;\a' "${CLAUDE_MONITOR_PORT:-4173}" "$SID"
fi
```

### Or let Claude do it

Don't want to touch shell scripts? Ask Claude Code to wire it up — in any session, say something like:

> Add a clickable Claude Monitor link to my Claude Code status line that opens `http://localhost:4173/#/session/<session_id>` for the current session, using the `session_id` Claude Code passes to the status line command. Update my status line script (or create `~/.claude/statusline.sh`) and `~/.claude/settings.json`.

It'll read your current setup, drop in the OSC 8 snippet, and update `settings.json` for you.

> A brand-new session is imported on a ~5s poll, so the link may briefly show "session not found" until its first import lands.

</details>

## Uninstall

<details>
<summary><b>Remove claude-monitor completely</b> — stop the process, delete data, uninstall the package</summary>

claude-monitor stores all its state in a single directory and registers no system services, daemons, or login items. To remove it completely:

**1. Stop any running instance.** If `claude-monitor start` is running in a terminal, press `Ctrl+C`. To find a stray background process:

```bash
pgrep -fa claude-monitor
# then: kill <pid>
```

**2. Delete the data directory.** This removes the SQLite database and its WAL/SHM sidecar files — every imported session, event, and analysis result:

```bash
rm -rf ~/.claude-monitor
```

**3. Uninstall the package** (skip this step if you only ever ran it via `npx`):

```bash
npm uninstall -g @pigorv/claude-monitor
```

That's everything. claude-monitor never writes outside `~/.claude-monitor/`, and **`~/.claude/projects/` belongs to Claude Code itself — leave it alone unless you also want to delete your transcripts.**

</details>

## Built With

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Preact](https://img.shields.io/badge/Preact-HTM-673AB8?logo=preact&logoColor=white)](https://preactjs.com/)
[![Hono](https://img.shields.io/badge/Hono-server-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![uPlot](https://img.shields.io/badge/uPlot-charts-4C566A)](https://github.com/leeoniya/uPlot)

## Development

<details>
<summary><b>Build and run from source</b> — clone, build, and the dev scripts</summary>

```bash
git clone https://github.com/pigorv/claude-monitor.git
cd claude-monitor
npm install
npm run build          # Build CLI + frontend (one-time, required before dev:server)
npm run dev            # Rebuild CLI on change (tsup --watch)
npm run dev:server     # Run the rebuilt server on :4173 (node --watch)
npm run dev:frontend   # Vite dev server on :5173 with HMR (proxies /api → :4173)
npm test               # Run tests
npm run typecheck      # TypeScript type checking
```

</details>

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup and conventions.

See [docs/TESTING.md](./docs/TESTING.md) for the testing strategy — the L0–L6 pyramid, quality gates, and coverage targets.

## License

[MIT](./LICENSE)
