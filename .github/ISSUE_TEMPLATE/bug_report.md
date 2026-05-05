---
name: Bug Report
about: Report something that isn't working correctly
labels: bug
---

## Pre-submit checklist

- [ ] I searched [existing issues](https://github.com/pigorv/claude-monitor/issues?q=is%3Aissue) and didn't find a duplicate
- [ ] I checked [CHANGELOG.md](https://github.com/pigorv/claude-monitor/blob/main/CHANGELOG.md) for recent changes related to this
- [ ] I'm on the latest published version (`npx @pigorv/claude-monitor@latest --version`)

## Description

A clear, one- or two-sentence description of the bug.

## Steps to reproduce

1.
2.
3.

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include error messages, stack traces, or screenshots if available.

## Affected area

Tick all that apply:

- [ ] Ingestion (JSONL parsing, transcript import, watcher)
- [ ] Dashboard UI (session list, timeline, context chart, agent tree)
- [ ] CLI (`start`, `import`, `status` commands)
- [ ] Database (SQLite schema, migrations, queries)
- [ ] Other / not sure

## Transcript / data context

If the bug involves missing sessions, wrong token counts, broken charts, or any discrepancy between what's in the JSONL and what the dashboard shows, please include:

- **Path to relevant transcript** (e.g. `~/.claude/projects/<project>/<session-uuid>.jsonl`)
- **What the dashboard shows:**
- **What the JSONL contains:** (redacted excerpts are fine — feel free to remove prompts/file contents)
- **Output of** `claude-monitor status` (database stats):

If the bug is purely UI/CLI behavior with no data discrepancy, leave this section blank.

## Screenshots / logs

Drag in screenshots and paste relevant log output. Running with `--verbose` (e.g. `npx @pigorv/claude-monitor start --verbose`) often helps.

## Environment

- **claude-monitor version:** (`npx @pigorv/claude-monitor --version`)
- **Node.js version:** (`node --version`)
- **OS and version:** (e.g. macOS 15.3, Ubuntu 24.04, Windows 11)
- **Claude Code version:** (if relevant — `claude --version`)
- **Browser:** (if the bug is in the dashboard UI)

## Regression

- [ ] This used to work in a previous version
- [ ] This has never worked for me
- [ ] Not sure

If it's a regression, the last known good version was: `vX.Y.Z`

## Severity

- [ ] Blocking — I can't use claude-monitor because of this
- [ ] Major — a key feature is broken but I have a workaround
- [ ] Minor — annoying but doesn't really get in the way
