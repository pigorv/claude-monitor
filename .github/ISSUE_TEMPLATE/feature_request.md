---
name: Feature Request
about: Suggest an improvement or new capability
labels: enhancement
---

## Pre-submit checklist

- [ ] I searched [existing issues](https://github.com/pigorv/claude-monitor/issues?q=is%3Aissue) and didn't find a duplicate request
- [ ] I checked the `[Unreleased]` section of [CHANGELOG.md](https://github.com/pigorv/claude-monitor/blob/main/CHANGELOG.md) — this isn't already in flight
- [ ] I checked the [Features section of the README](https://github.com/pigorv/claude-monitor#features) — this isn't already shipped

## Problem statement

What problem does this solve? What's frustrating, missing, or hard about claude-monitor today?

## Proposed solution

Describe the feature you'd like and how it should behave. Mockups, sketches, or links to similar features in other tools are very welcome.

## Affected area

Tick all that apply:

- [ ] Ingestion (JSONL parsing, transcript import, watcher)
- [ ] Dashboard UI (session list, timeline, context chart, agent tree)
- [ ] CLI (`start`, `import`, `status` commands)
- [ ] Analysis (compaction detection, token tracking, agent efficiency)
- [ ] Database (SQLite schema, migrations, queries)
- [ ] Docs

## Alternatives considered

Other approaches you thought about and why they're less ideal. "I considered X but it doesn't address Y" is a great answer.

## Success criteria

How would we know this feature is working as intended? Concrete, observable signals — e.g. "the session detail page shows tool-call latency in milliseconds next to each tool call".

## Importance

How much does this matter to your workflow?

- [ ] Nice to have
- [ ] Useful — would noticeably improve my experience
- [ ] Important — I work around the lack of this regularly
- [ ] Blocking — I can't really use claude-monitor for my use case without it

## Additional context

Screenshots, mockups, links to related issues, examples from other tools.
