# Feature extraction

How to turn `CHANGELOG.md` plus the live code surface into a tight, benefit-led features list.

This file covers **voice and shaping** of the final feature lines. For the **net-state aggregation** algorithm used when the range is wider than `[Unreleased]`, see `changelog-aggregation.md`.

## Sources, in priority order

1. **CHANGELOG slice** for the chosen range — `[Unreleased]` only by default; wider ranges via `since=<ver>`, `since=tag`, `all`. For wider ranges, run net-state aggregation first (see `changelog-aggregation.md`) and feed the surviving keys here. Skip `Fixed` and `Removed` for the README features list — `Fixed` doesn't add features, `Removed` already pruned the set.
2. **`src/cli/index.ts` + `src/cli/commands/*.ts`** — current commands and flags. Every public command should be in the CLI reference table; flags worth surfacing on the homepage go in the features list.
3. **`src/server/` Hono routes** — confirms which API capabilities exist. Usually informational; rarely a feature line on its own.
4. **`frontend/src/pages/*.tsx` + `frontend/src/App.tsx`** — confirms which pages/tabs exist. New tabs and new visible columns on the SessionList are usually feature-worthy.
5. **`frontend/src/components/*.tsx`** — useful when a component name maps directly to a feature (e.g., `Heatmap.tsx`, `TokenChart.tsx`).

## What counts as user-facing

Include in the features list:

- New page, tab, modal, or significant view
- New filter, sort, search, or visible column
- New CLI command or behavior-changing flag
- New visible data (e.g., token costs, agent tree, compaction markers)
- New integration the user touches (e.g., "Open in Terminal")

Exclude:

- Migrations, schema changes, refactors
- Test, CI, lint, formatting, dependency upgrades
- Internal performance work the user can't see
- Bug fixes (unless the bug was so notorious that fixing it is itself a feature)
- Meta-entries about the README/docs themselves

## Voice

Match the existing list. Each feature is **one** line:

```
**<Capability>** — <What it does, one short sentence>. <Optional second sentence on why it matters>.
```

Concrete over generic. "Filterable, sortable table with model filter chips, search, sparkline previews" beats "Browse your sessions easily."

Lead with the noun the user recognizes (Session List, Context Pressure, Agent Tree). End with the benefit, not the implementation.

## Worked example — single-version run

Given this `[Unreleased]` block:

```
### Added
- One-click "Open in Terminal" button on session detail pages (macOS). Opens
  Terminal.app or iTerm2, cd's into the session's project directory, and runs
  `claude --resume <id>` automatically.

### Changed
- Session list trailing column now renders a "Health" strip (context %,
  peak tokens vs. 1M, and up to three compaction dots) instead of the
  generic sparkline.

### Fixed
- Context chart and session-list sparklines now include tool-only assistant turns.
- Agent tab: "Result returned" section is now collapsed by default.
```

The README features list adds one line and modifies one line:

```markdown
**Resume in Terminal** — One click opens Terminal.app or iTerm2 in the session's
project folder and runs `claude --resume <id>`. Pick your preferred app in Settings.

**Session List** — Filterable, sortable table with model filter chips, search,
a Health strip showing context %, peak tokens, and recent compactions, plus
color-coded compaction counts.
```

The two `Fixed` entries do not become README features.

## Worked example — `since=` range run

When the range covers multiple versions, the input to this step is the surviving feature set from `changelog-aggregation.md`, with provenance. For example:

```
Surviving features (net state, since=0.2.0):
  Session List          [added 0.1.0; changed 0.3.0 (project filter, multi-model pill); changed [Unreleased] (Health strip)]
  Multi-model pill      [added 0.3.0]
  Project filter        [added 0.3.0]
  Resume in Terminal    [added [Unreleased]]
```

For each surviving key, write **one** line in the standard voice. When two keys are tightly related and one is "subordinate" to the other, fold them — e.g., `Multi-model pill` and `Project filter` both belong inside `Session List`'s description rather than as separate top-level lines:

```markdown
**Session List** — Filterable, sortable table with model filter chips, project
folder filter (with session counts), Sonnet→Opus multi-model pills, search,
and a Health strip showing context %, peak tokens, and recent compactions.

**Resume in Terminal** — One click opens Terminal.app or iTerm2 in the session's
project folder and runs `claude --resume <id>`. Pick your preferred app in Settings.
```

Folding is a judgment call — when in doubt, keep them separate and ask the user.

## Sizing the list

Aim for 4–7 lines. If you're at 8+, fold related items into a parent. If you're at 3 or fewer, the chosen range is small — usually fine for a patch release where the README doesn't need feature changes at all, only quickstart/CLI updates.

## When code disagrees with the changelog

Code wins. If the CHANGELOG says a feature exists but the page or command isn't there, flag it back to the user before writing the README line — the changelog entry is probably stale and should be amended first.

## CLI reference table

The `<!-- cli:start -->` block is sourced from `src/cli/commands/*.ts`. Each command's `description` field becomes the table row. Each `option(...)` becomes a bullet under "Options for `<command>`".

Don't paste the full `--help` dump. Pick flags that change user behavior (port, db path, force, no-open, verbose) and skip the universal ones (`--version`, `--help`).

## Removed commands

When the range includes a version that removed a command (e.g., `watch` in 0.3.0), make sure the CLI block does **not** list it. The net-state aggregation in `changelog-aggregation.md` already drops it from the feature set, but the CLI block is sourced from code — verify the command is actually gone from `src/cli/commands/` and `src/cli/index.ts` before writing.
