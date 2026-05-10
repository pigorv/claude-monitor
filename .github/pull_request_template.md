## Summary

What does this PR do and why?

## Linked issue

<!-- Use `Closes #123` to auto-close on merge, or `Refs #123` to link without closing. -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] Build / CI / tooling
- [ ] Tests only

## Affected area

- [ ] Ingestion (JSONL parsing, transcript import, watcher)
- [ ] Dashboard UI (session list, timeline, context chart, agent tree)
- [ ] CLI (`start`, `import`, `status` commands)
- [ ] Analysis (compaction detection, token tracking, agent efficiency)
- [ ] Database (SQLite schema, migrations, queries)
- [ ] Build & CI

## Test plan

How did you verify this works? Include the commands you ran, fixtures or transcripts you tested against, and any UI flows you exercised in the browser.

## How to validate

Concrete steps a reviewer can run themselves to confirm the change behaves as described — commands, URLs to open, fixtures to load, what to look for vs. what would be a regression. Keep it short and specific (the goal is "I ran these three things in 2 minutes and saw the right thing").

## Risk / rollout notes

Anything reviewers should know before merging — schema migrations, breaking CLI flag changes, new runtime dependencies, performance implications. "None" is a fine answer.

## Checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] Tests added or updated for changed behavior
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
