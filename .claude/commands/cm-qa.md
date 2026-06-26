---
description: Manual-QA a claude-monitor PR — run the app, walk the "How to validate" flow in a browser, record a video, run regression smoke tests, and report a per-step PASS/FAIL verdict in chat, then offer to post the verdict to the PR.
---

You have been invoked via `/cm-qa`. Run the **cm-qa** skill end-to-end.

Read `.claude/skills/cm-qa/SKILL.md` first and follow it phase by phase. Do not skip the regression smoke tests (Phase 4b) or the video delivery (Phase 5). Results go to **chat first**; only post to the PR (Phase 6) after an explicit `go`.

## Arguments

`$ARGUMENTS` is a space-separated token list. Recognized tokens:

- *(empty)* — QA the PR for the **current branch**.
- `<pr-number>` / `<pr-url>` — QA that specific PR (check it out first).
- `--base <branch>` — override the base used for the affected-area diff.
- `--no-video` — run the flow and report, but skip video recording.
- `--keep-running` — leave the dev server up after the run.

## Examples

```
/cm-qa
/cm-qa 142
/cm-qa https://github.com/pigorv/claude-monitor/pull/142
/cm-qa 142 --no-video
```

This skill reports the verdict and video to **you in chat** every run. It will then offer to mirror the verdict onto the PR as a comment — but posts only after you reply `go`. It never reviews, approves, pushes, or merges.
