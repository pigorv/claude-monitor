---
description: Refresh README.md ahead of a release — aggregate CHANGELOG entries (single version or any range) to net state, plan media with an explicit hero-recapture verdict, and surgically update marker-bounded sections.
---

You have been invoked via `/readme`. Run the **cm-readme** skill end-to-end to bring `README.md` up to date.

Read `.claude/skills/cm-readme/SKILL.md` first and follow it step by step. Do not skip the verification step at the end.

## Arguments

`$ARGUMENTS` is a space-separated token list. Recognized tokens:

**Range selection** (pick at most one; default is `[Unreleased]` only):

- `since=<version>` — aggregate from the version *after* `<version>` up to and including `[Unreleased]`. Example: `since=0.2.0` covers `0.2.1`, `0.3.0`, `0.3.1`, `[Unreleased]`.
- `since=tag` — aggregate from the most recent git tag up to `[Unreleased]`. Behaves like the default in most cases.
- `all` or `from-beginning` — aggregate every released version plus `[Unreleased]`. Use this to **rebuild** the features list from net state, dropping anything that has been removed.

**Scope** (combine freely):

- `dry-run` — show the proposed diff but do NOT write to README.md
- `features-only` — only update the `<!-- features:* -->` block
- `media-only` — only run the media plan + capture step
- `hero` | `features` | `quickstart` | `cli` — restrict to one marker block

If `$ARGUMENTS` is empty, run the full workflow with the default `[Unreleased]`-only range.

## Examples

```
/readme
/readme dry-run
/readme since=0.2.0
/readme all dry-run
/readme features-only
/readme hero media-only
```
