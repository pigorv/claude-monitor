# Pre-release README checklist

Run this in step 5 of `SKILL.md`. Anything that fails is a blocker — surface it to the user and stop.

## Range + aggregation (only when range is wider than `[Unreleased]`)

- [ ] The user saw the surviving-feature list with provenance before any write
- [ ] Every key in `Removed` across the range is absent from the final feature list
- [ ] Every CLI command removed in the range is absent from the CLI table
- [ ] Flagged ambiguous keys ("no clean code match") were resolved by the user, not silently kept

## Structural

- [ ] Every `<!-- name:start -->` has a matching `<!-- name:end -->` and vice versa
- [ ] Marker pairs do not overlap or nest
- [ ] All four expected blocks are present: `hero`, `quickstart`, `features`, `cli`
- [ ] No content was added or modified outside marker blocks
- [ ] The `<!-- hero captured-on: vX.Y.Z -->` annotation is present and well-formed

## Hero verdict

- [ ] Verdict is one of REQUIRED / RECOMMENDED / NOT NEEDED — never blank or "maybe"
- [ ] Verdict cites specific CHANGELOG entries (not a generic "things changed")
- [ ] If verdict was REQUIRED and user approved recapture: `captured-on` was bumped to the current version
- [ ] If verdict was REQUIRED and user deferred: `captured-on` was **not** changed; report includes a "Hero re-capture deferred" line
- [ ] If verdict was NOT NEEDED: nothing in the hero block was touched, including the annotation

## Features list

- [ ] 4–7 feature lines (collapse if more, ask the user if fewer)
- [ ] Each line starts with `**<Capability>** —` and is one paragraph
- [ ] Every surviving feature key has a line; every dropped key does not
- [ ] No fixed/removed items leaked into the features list
- [ ] No CI/build/dep work leaked into the features list
- [ ] No meta-entries (e.g., "Hero GIF and feature screenshots in README") leaked in

## Media

- [ ] Every `<img src="docs/images/…">` resolves to a file that exists
- [ ] Every `<img>` has descriptive alt text (≥10 words, describes what's literally on screen)
- [ ] Image widths are consistent (`width="700"` for inline feature shots unless wider intentionally)
- [ ] Hero block contains exactly one media element (video or img)
- [ ] No image is >1.5 MB without a justified reason

## CLI block

- [ ] Every command in `src/cli/commands/*.ts` has a row in the table
- [ ] No removed command appears in the table (cross-check against the dropped set from aggregation)
- [ ] Flags listed under "Options for …" actually exist on the command in code

## Quickstart

- [ ] `npx @pigorv/claude-monitor` package name matches `package.json` `name`
- [ ] Default port matches the actual server default (currently 4173)
- [ ] Node version requirement matches `package.json` `engines.node`

## Diff sanity

- [ ] `git diff --stat README.md` shows changes only in expected line ranges
- [ ] `git diff README.md` reads cleanly (no doubled blank lines, no markdown lint warnings)

## Reporting back

When done, tell the user:

1. Range used (e.g., "since=0.2.0 → 0.2.1, 0.3.0, 0.3.1, [Unreleased]")
2. Surviving features and dropped features (from aggregation)
3. Per-feature image actions: RECAPTURE / REUSE / SKIP / NEW
4. Hero verdict + reason + new captured-on (or unchanged + deferred)
5. Total lines changed (`git diff --shortstat README.md`)
6. Any checklist items that did not pass and why
7. Whether `dry-run` was active (so the user knows nothing was written)
