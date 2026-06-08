---
name: release-readme
description: Use ONLY when the user explicitly invokes the /readme slash command, or asks to "run the release-readme skill". Refreshes README.md before a release by reconciling a chosen CHANGELOG range against the live code surface (Hono routes, Preact pages, CLI commands), aggregating Added/Changed/Removed entries to net-state, planning screenshot/GIF captures with an explicit hero re-capture verdict, and editing only between HTML comment markers. Do NOT trigger on generic "update readme" requests — the user wants this skill to fire only on explicit invocation.
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*), Bash(npm:*), Bash(node:*), Bash(jq:*), Bash(playwright-cli:*), Bash(ls:*), Bash(diff:*), Bash(file:*), Bash(stat:*)
---

# release-readme

Pre-release helper that keeps `README.md` honest. Reads a chosen range of `CHANGELOG.md`, aggregates Added/Changed/Removed entries to **net state as of HEAD**, edits only between HTML comment markers in the README, plans the media work with an explicit hero-recapture verdict, and verifies before handing off.

This skill is **read-only on version metadata** — it never bumps `package.json` or moves `[Unreleased]` headers in `CHANGELOG.md`.

---

## Arguments (`$ARGUMENTS`)

Parse the slash command argument string before anything else. Recognized tokens:

| Token | Meaning |
|---|---|
| *(empty)* | Default: range = `[Unreleased]` only |
| `since=<ver>` | Range = `<ver>` (exclusive) → `[Unreleased]` (inclusive). E.g., `since=0.2.0` |
| `since=tag` | Range = last git tag (`git describe --tags --abbrev=0`) → `[Unreleased]`. Same as default in practice. |
| `all` or `from-beginning` | Range = first version in CHANGELOG → `[Unreleased]` |
| `dry-run` | Produce diff but do not write README.md |
| `features-only` | Only update `<!-- features:* -->` |
| `media-only` | Only run media plan + capture |
| `hero` \| `features` \| `quickstart` \| `cli` | Restrict to a single marker block |

Tokens combine: `/readme since=0.2.0 dry-run features-only` is valid.

If `all` is set, also tell the user up front: "Running full-history aggregation — this rebuilds the entire feature list from net state, not just additions."

---

## Workflow

Run these steps in order.

### 1. Inventory

```bash
jq '{name, version, bin, engines}' package.json
git tag --sort=-v:refname | head -10
git describe --tags --abbrev=0 2>/dev/null || echo "(no tags)"
ls docs/images/
```

Read `README.md`. Note:

- Which marker blocks exist. If any are missing, see *Bootstrapping markers* below.
- The hero's `captured-on` annotation if present. Look for a comment of the form `<!-- hero captured-on: v0.3.1 -->` immediately after `<!-- hero:start -->`. If absent, treat it as `v0.0.0` (i.e., assume the hero is older than every released version) — this means the hero verdict will lean toward RECOMMENDED unless overridden.

Read `CHANGELOG.md` with the `Read` tool, then mentally slice it based on `$ARGUMENTS`. The CHANGELOG uses `## [Version] - YYYY-MM-DD` headers (and a bare `## [Unreleased]` at the top). Slice rules:

- *(default)* — only the `[Unreleased]` block.
- `since=X.Y.Z` — every block whose version is strictly newer than `X.Y.Z`, plus `[Unreleased]`. SemVer compare; do **not** rely on file order.
- `since=tag` — `since=` the most recent git tag (`git describe --tags --abbrev=0`).
- `all` / `from-beginning` — every released version plus `[Unreleased]`.

If the resulting slice has zero `Added`/`Changed` entries (e.g. `[Unreleased]` is empty right after a release), report `README is up-to-date for this range — nothing to do` and **stop before step 2**. Don't fabricate work.

Then read code:

- `src/cli/index.ts` and `src/cli/commands/*.ts` — current CLI commands and flags
- `src/server/` — current Hono route surface (`/api/...`)
- `frontend/src/pages/` and `frontend/src/App.tsx` — current SPA pages and tabs
- `frontend/src/components/*.tsx` — visible UI components when relevant

If a reference file would help, load it now:

- `references/changelog-aggregation.md` — **load whenever the range is wider than `[Unreleased]`** (covers `since=`, `all`, `from-beginning`)
- `references/feature-extraction.md` — voice/sizing rules for the features list
- `references/media-capture.md` — Playwright recipes + the **hero re-capture decision matrix**
- `references/readme-template.md` — canonical layout of marker blocks
- `references/checklist.md` — the verifier used in step 5

### 2. Extract features (with range aggregation)

If the range is `[Unreleased]` only, work as before: union CHANGELOG `[Unreleased] → Added` and `[Unreleased] → Changed` with anything visible in code that's missing from the current README features list.

If the range spans multiple versions, run the **net-state aggregation** algorithm in `references/changelog-aggregation.md`. Summary:

1. Walk versions oldest → newest in the chosen range.
2. For each entry, classify into a stable feature key (lead noun phrase) and apply:
   - `Added X` → insert/replace key in the feature set
   - `Changed X` → update the description for the matched key (or add new key if no match)
   - `Removed X` → drop the matched key
   - `Fixed X` → ignore (does not affect the features list)
3. After the full walk, the surviving keys are the **net features as of HEAD**.
4. Cross-check against code: any surviving key whose UI element no longer exists in `src/`/`frontend/` is suspicious — flag it for the user.
5. Cross-check against code: any UI element in code that has no matching surviving key is also suspicious — the changelog probably missed it.

Output the surviving feature list to the user **with provenance** before writing anything:

```
Surviving features (net state):
  Session List          [added 0.1.0; changed 0.3.0 (project filter, multi-model pill); changed [Unreleased] (Health strip)]
  Context Pressure      [added 0.1.0]
  Thinking Inspection   [added 0.1.0]
  Agent Tree            [added 0.1.0; changed 0.3.0 (token impact bars, full-content sections)]
  File Tracking         [added ?? — present in code, no clean changelog match — please confirm]
  Resume in Terminal    [added [Unreleased]]
Dropped (removed in range):
  watch command         [added 0.1.0; removed 0.3.0]
```

Then map each surviving key to one feature line in the standard voice (see `references/feature-extraction.md`). Do **not** mention removed features in the final list.

### 3. Plan media — with explicit hero verdict

Output two artifacts:

**A. Per-feature image checklist** — one row per feature:

```
feature                  | target file                                  | currently | action
Session List             | docs/images/session-list.png                 | EXISTS    | RECAPTURE  (Health strip is new)
Context Pressure         | docs/images/session-detail-context.png       | EXISTS    | REUSE
Thinking Inspection      | docs/images/session-detail-timeline.png      | EXISTS    | REUSE
Agent Tree               | docs/images/session-detail-agents.png        | EXISTS    | REUSE
Resume in Terminal       | (text-only — no inline image)                | —         | SKIP
```

**B. Hero re-capture verdict** — one of `REQUIRED` / `RECOMMENDED` / `NOT NEEDED`, with a one-paragraph reason citing the specific CHANGELOG entries that drove the decision.

The decision algorithm is in `references/media-capture.md` under "Hero re-capture decision". Summary:

- `REQUIRED` if any CHANGELOG entry in the range, classified as `Added` or major `Changed`, touches a route/page that the hero walkthrough is known to traverse (currently: session list `/`, session detail Context/Timeline/Agents tabs). Examples that trigger REQUIRED: a new tab on session detail, a new visible button on every session detail (like "Open in Terminal"), a new always-visible column on the session list (like the Health strip).
- `RECOMMENDED` if a hero-visible route got a non-trivial visual change but the change is small enough that the hero is still broadly representative (e.g., a badge color update, a renamed label). Tell the user the hero is "stale but watchable".
- `NOT NEEDED` if every entry in the range is backend, CLI-only, fixes, or pure docs. Hero stays.

After deciding, update the captured-on annotation **only when** the hero is actually recaptured: rewrite the inner comment to `<!-- hero captured-on: v<currentVersion> -->`. If the verdict is REQUIRED but the user defers the recapture, leave the annotation alone so the next run still flags REQUIRED.

If `media-only` was passed, perform captures now using the recipes in `references/media-capture.md`. Otherwise, present the checklist + verdict to the user, ask for explicit go-ahead per item, and proceed. **Never auto-capture without confirmation.**

### 4. Edit between markers

Use `Edit` to rewrite **only** between matching `<!-- name:start -->` / `<!-- name:end -->` markers. The safest pattern is: include both markers in `old_string` and `new_string`, copied verbatim from `Read`, with the block content between them. That way the markers anchor the edit and you can't accidentally clip a leading blank line or eat the next heading.

```text
old_string:
  <!-- features:start -->
  ## Features

  **Session List** — ...older copy...
  <!-- features:end -->

new_string:
  <!-- features:start -->
  ## Features

  **Session List** — ...new copy...
  <!-- features:end -->
```

For the hero block, keep `<!-- hero captured-on: vX.Y.Z -->` inside `old_string` even when you're not changing it — re-emit it unchanged in `new_string`. Only rewrite that line when step 3 actually recaptured the hero.

Never touch:

- Headings or content outside marker blocks
- The "Contents" (TOC), "Why?", "How It Works", "Status line link", "Uninstall", "Built With", "Development", "Contributing", "License" sections
- The `<!-- hero captured-on: ... -->` annotation, **unless** step 3 actually recaptured the hero

Preserve `<p align="center">`, `<img width="…">`, and alt text formatting. Use **absolute** `https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/…` URLs for every image `src` — npm's registry strips relative image paths, so they render blank on npmjs.com (this was the v0.3.4 fix). Match the existing alt-text style (one descriptive sentence; ~120 chars).

### 5. Verify

Run the checklist in `references/checklist.md`. Minimum:

```bash
# All referenced images exist
grep -oE 'docs/images/[^"\) ]+' README.md | sort -u | while read p; do
  test -f "$p" && echo "OK  $p" || echo "MISS $p"
done

# Marker integrity (every :start has a :end and vice versa)
grep -nE '<!-- [a-z]+:(start|end) -->' README.md

# Hero captured-on annotation present and well-formed
grep -nE '<!-- hero captured-on: v[0-9]+\.[0-9]+\.[0-9]+ -->' README.md

# Diff for the user
git diff --stat README.md
git diff README.md | head -200
```

Report back:

- Range used (e.g., "since=0.2.0" → 0.2.1, 0.3.0, 0.3.1, [Unreleased])
- Net features list (surviving + dropped)
- Per-feature image actions (RECAPTURE / REUSE / SKIP / NEW)
- Hero verdict + reasoning + new captured-on (or unchanged)
- Lines changed (`git diff --shortstat README.md`)
- Any unresolved checklist items
- Whether `dry-run` was active

---

## Marker convention

```markdown
<!-- hero:start -->
<!-- hero captured-on: v0.3.1 -->
<p align="center"> ... </p>
<!-- hero:end -->

<!-- quickstart:start --> ... <!-- quickstart:end -->
<!-- features:start -->  ... <!-- features:end -->
<!-- cli:start -->       ... <!-- cli:end -->
```

The `captured-on` annotation goes **inside** `<!-- hero:start -->` and `<!-- hero:end -->`, on its own line, right after `:start`. It is the only state the skill writes about the hero — there is no separate metadata file.

If a marker pair is missing, use *Bootstrapping markers* below.

---

## Bootstrapping markers

If the README does not yet have markers (first-ever run):

1. Read the README.
2. Wrap `## Quick Start`, `## Features`, `## CLI Reference` and the centered `<p>` hero block with their respective markers (one `Edit` per pair, content unchanged).
3. Set `<!-- hero captured-on: vX.Y.Z -->` inside `<!-- hero:start -->`. **Ask the user which version the existing hero roughly represents** — captured-on is a staleness opinion, not a recorded fact, and getting it wrong on bootstrap means the next run mis-flags the verdict. If the user shrugs, default to `package.json`'s current version (the optimistic choice — assumes the hero is fresh; if it isn't, the user will recapture on the next run anyway).
4. Then proceed with steps 1–5.

Marker placement examples are in `references/readme-template.md`.

---

## What this skill never does

- Edit `package.json` version
- Move `[Unreleased]` to a dated header in `CHANGELOG.md`
- Create git tags or push commits
- Rewrite the "Contents" (TOC), "Why?", "How It Works", "Status line link", "Uninstall", "Built With", "Development", "Contributing", "License" sections
- Auto-capture screenshots without confirming with the user first
- Rewrite the `captured-on` annotation unless a hero recapture actually happened in this run

---

## Quick reference: existing media

```
docs/images/hero.gif
docs/images/session-list.png
docs/images/session-detail-context.png
docs/images/session-detail-timeline.png
docs/images/session-detail-agents.png
```

Hero is a committed `docs/images/hero.gif`, referenced via an absolute `<img src="https://raw.githubusercontent.com/pigorv/claude-monitor/main/docs/images/hero.gif" …>`. Replace the GIF (and bump the `captured-on` annotation) when the verdict is REQUIRED and the user has approved the new asset.
