# README marker template

The canonical layout the skill assumes. Anything outside the marker pairs is the user's territory and must not be touched.

```markdown
# claude-monitor

> Local observability dashboard for Claude Code sessions — see what your context window is actually doing.

[![CI](…)](…)
[![npm](…)](…)
[![License: MIT](…)](…)
[![Node](…)](…)

<!-- hero:start -->
<!-- hero captured-on: vX.Y.Z -->
<p align="center">
  <img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/hero.gif" alt="claude-monitor walkthrough" style="max-width: 100%;" />
</p>
<!-- hero:end -->

## Contents

…manual linked TOC of the section headings — not touched by the skill…

## Why?

…manual prose, not touched by the skill…

<!-- quickstart:start -->
## Quick Start

First, import every existing Claude Code session from `~/.claude/projects/`:

```bash
npx @pigorv/claude-monitor import ~/.claude/projects/
```

Then start the dashboard — it opens at `http://localhost:4173`:

```bash
npx @pigorv/claude-monitor start
```

**Requirements:** Node.js >= 20, Claude Code (for transcript files)
<!-- quickstart:end -->

<!-- features:start -->
## Features

**Session List** — Filterable, sortable table with model filter chips, search, sparkline previews, and color-coded compaction counts.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-list.png" alt="Session list showing 10 sessions across 4 projects with sparkline charts, model badges, compaction counts, and agent counts" width="700" />

**Context Pressure** — Interactive token chart (uPlot) with input/output/cache breakdown, model-specific thresholds, compaction markers, and drag-to-zoom.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-detail-context.png" alt="Context utilization chart showing token pressure climbing over time with two compaction drops and warning/danger threshold zones" width="700" />

**Thinking Inspection** — Expandable thinking blocks in the event timeline. See exactly where Claude's reasoning chain took a wrong turn.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-detail-timeline.png" alt="Timeline view showing chronological event cards with tool calls, thinking blocks, and a token budget bar at 94% context utilization" width="700" />

**Agent Tree** — Full sub-agent visibility with Gantt timeline, per-agent token costs, tool call breakdowns, compression ratios, and result classification.

<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/session-detail-agents.png" alt="Agent tree with Gantt chart showing 5 sub-agents with timeline bars, token counts, tool call counts, and status badges" width="700" />

**File Tracking** — Every file loaded into context, how many times it was re-read, and how many tokens each file consumed. Spot wasteful re-reads.
<!-- features:end -->

## How It Works

…manual prose, not touched by the skill…

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

## Built With … ## Development … ## Contributing … ## License
…manual prose, not touched by the skill…
```

## Marker placement rules

1. Marker comments live on their own line. No content on the same line.
2. `<!-- name:start -->` immediately precedes the block content. For `quickstart`, `features`, `cli`, that means the line directly before the `## ` heading. For `hero`, that means the line before the `<p align="center">`.
3. `<!-- name:end -->` immediately follows the block content. The line below it is typically the next `## ` heading or a blank line before it.
4. Marker names are lowercase, single word: `hero`, `quickstart`, `features`, `cli`. No new marker names without updating SKILL.md.
5. Marker pairs do **not** overlap or nest.

## What does NOT go inside markers

- Title (`# claude-monitor`)
- Tagline blockquote
- Badges row
- "Contents" (TOC)
- "Why?" section
- "How It Works" section
- "Status line link" section (folded in `<details>`)
- "Uninstall" section (folded in `<details>`)
- "Built With" section
- "Development" section (folded in `<details>`)
- "Contributing" section
- "License" section

Those are stable across releases or change for reasons orthogonal to a release-prep run, so they're explicitly outside the skill's edit zone.
