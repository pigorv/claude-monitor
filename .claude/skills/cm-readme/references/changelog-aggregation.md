# Changelog aggregation (net-state)

Used in step 2 of `SKILL.md` whenever the range is wider than `[Unreleased]` only — i.e., `since=<ver>`, `since=tag`, `all`, `from-beginning`.

The goal: walk every `Added` / `Changed` / `Removed` entry chronologically and produce the **net feature set as of HEAD**. A feature added in 0.1.0 then removed in 0.3.0 must not appear. A feature added in 0.1.0 and changed twice since must appear once with the *current* description.

## Inputs

- `CHANGELOG.md` sliced to the chosen range
- The current code surface (routes, pages, CLI commands) for cross-validation

## Algorithm

```
features := empty ordered map (key → { added_in, last_changed_in, latest_description })
removed  := empty set of keys

for each version V in range, oldest → newest:
    for each entry E under V → Added:
        key := classify(E)
        features[key] := { added_in: V, last_changed_in: V, latest_description: E.text }
        removed.discard(key)            # an Add after a Remove resurrects the feature

    for each entry E under V → Changed:
        key := classify(E)
        if key in features:
            features[key].last_changed_in := V
            features[key].latest_description := merge(features[key].latest_description, E.text)
        else:
            # The feature exists but was never explicitly Added in the changelog
            # (common for early features). Treat the Changed entry as the seed.
            features[key] := { added_in: "?", last_changed_in: V, latest_description: E.text }

    for each entry E under V → Removed:
        key := classify(E)
        features.pop(key, default=None)
        removed.add(key)

    # Fixed: ignore. Fixes never affect the features list.

# After the walk:
return features.values(), removed
```

## Classifying entries to keys

`classify(entry)` extracts a stable key — the lead noun phrase the entry is about. The skill matches on lemmatized form, lowercase, with these heuristics:

1. **Lead bold or quoted phrase**: if the entry begins with `**X**` or `` `X` ``, that's the key. Examples:
   - `` Removed `watch` command (use `import` or `start` instead) `` → key = `watch command`
   - `**Resume in Terminal** — One click opens ...` → key = `resume in terminal`

2. **Subject before the em-dash**: many entries follow the pattern `Subject — explanation`. Use the subject side. Example:
   - `Multi-model pills on session detail page — model transitions ...` → key = `multi-model pills on session detail`

3. **First noun phrase**: fallback. Examples:
   - `Session list now displays AI-generated session title` → key = `session list`
   - `Session list trailing column now renders a "Health" strip` → key = `session list`
     - Both map to the same key, so the second `Changed` correctly mutates the first.

4. **Synonym table** (project-specific; extend over time). Each row maps any of the LHS strings to the canonical key on the RHS:
   - `health strip`, `trailing column health strip` → `session list health strip`
   - `agents tab`, `agent tab`, `agent tree` → `agent tree` (the page tab and the tree it renders are the same surface — fold them)
   - `multi-model pill`, `multi-model pills`, `multi-model indicator` → `multi-model pill`

When in doubt, ask the user — print the unmatched key and the candidate keys it could merge with, and pause for confirmation. Wrong key matching corrupts the whole net state.

### Entries that touch multiple features (fan-out)

Some entries describe a single change that lands in several places. Example:

> "Filters, search, sort, project selection, the active session-detail tab, and the selected agent on the Agents tab are now reflected in the URL hash."

If the lead clause is a comma/`and`-joined list of noun phrases that each map to a distinct existing key, classify the entry as **all** of those keys (fan-out). Each key gets the same `latest_description` for this iteration of the walk. Do **not** invent a new umbrella key like `url state` unless the user asks for one — the goal is to keep the description attached to the surfaces a reader of the README would look at.

Heuristic: only fan out when at least two of the noun phrases already exist in `features` (or in the synonym table). If only one matches, treat it as a single-key entry against that match. If none match, fall back to the single-key first-noun-phrase rule and flag the entry to the user.

## Merging descriptions

When the same key appears across multiple `Changed` entries, you want the user to see one coherent line, not a paste of every changelog text.

Strategy: take the most recent `Changed` text as the base (it's the latest UI state), then optionally suffix with sub-features from earlier entries that are still relevant. If the texts conflict (e.g., earlier "renders a sparkline", later "renders a Health strip"), keep only the latest.

Output the merged description back into the same voice and shape used by `references/feature-extraction.md`.

## Worked example — claude-monitor history

> **Illustrative only.** The entries below are paraphrased to demonstrate the algorithm. Always read the actual `CHANGELOG.md` — entry text and version numbers may have drifted since this was written.

Range: `all`. CHANGELOG has 0.1.0 → 0.2.0 → 0.2.1 → 0.3.0 → 0.3.1 → [Unreleased].

```
0.1.0 Added "watch command"            → features = { watch command: {0.1.0, 0.1.0, "..."} }
0.1.0 Added "session list, timeline, agent tree views" → splits into three keys
0.1.0 Added "context pressure scoring" → features += { context pressure: ... }
0.1.0 Added "JSONL transcript ingestion" → ingestion key (internal — flag for user, may not belong on README)
...
0.2.0 (mostly Fixed/Changed CSS — none affect feature keys except contrast/focus rings, which are not features)
0.3.0 Removed "watch command"          → features.pop("watch command")  ✅ removed from final state
0.3.0 Added "Multi-model pills"        → features += { multi-model pills: ... }
0.3.0 Added "Project folder filter"    → features += { project folder filter: ... }
0.3.0 Added "Multi-model indicator in session list" → key matches "multi-model pills" via synonym table, merges as Changed-equivalent
0.3.0 Added "Hero GIF and feature screenshots in README" → key = "readme media" (likely flag — this is meta-feature, not product feature)
0.3.0 Added "Demo data seeding script" → key = "demo seeding" (developer feature, may belong in Development section, not Features)
0.3.1 Fixed "Peak Tokens stat..."      → ignored
0.3.1 Fixed "Agents tab no longer duplicates" → ignored
[Unreleased] Added "Open in Terminal button" → features += { resume in terminal: ... }
[Unreleased] Changed "Session list trailing column → Health strip" → matches "session list" key, replaces description
```

Final net state (the features list the skill writes):

1. **Session List** — current description merged with the Health strip change
2. **Context Pressure** — from 0.1.0
3. **Thinking Inspection** — from 0.1.0 (timeline view)
4. **Agent Tree** — from 0.1.0
5. **Multi-model pill** — from 0.3.0 (or fold this into Session List + Session Detail descriptions; ask the user)
6. **Project filter** — from 0.3.0 (or fold into Session List)
7. **Resume in Terminal** — from [Unreleased]

The `watch` command is **gone**. Anything labeled "Hero GIF and feature screenshots in README" or "Demo data seeding script" should be flagged for the user as not-actually-a-product-feature before being included.

## Cross-checks against code

After aggregation:

```bash
# Every surviving key should map to a real surface in code. List CLI commands
# and SPA pages so the user can sanity-check.
grep -RhE "command\(['\"]" src/cli/commands/ | head -50
ls frontend/src/pages/
grep -RhE "<.*Tab.*>" frontend/src/pages/SessionDetail.tsx | head -20
```

If a surviving feature has no obvious code surface, ask the user. If a code surface has no surviving feature, also ask — the changelog probably missed something.

## Provenance output

Always print provenance with the surviving features so the user can verify the matching is right:

```
Surviving features (net state):
  Session List          [added 0.1.0; changed 0.3.0; changed [Unreleased]]
  Context Pressure      [added 0.1.0]
  Thinking Inspection   [added 0.1.0]
  Agent Tree            [added 0.1.0; changed 0.3.0]
  Multi-model pill      [added 0.3.0]
  Project filter        [added 0.3.0]
  Resume in Terminal    [added [Unreleased]]

Dropped (Removed in range):
  watch command         [added 0.1.0; removed 0.3.0]

Flagged (no clean code match — please confirm):
  ingestion (internal-only?)
  demo seeding (developer feature, not product feature?)
  readme media (meta entry — should it appear in features at all?)
```

Pause for the user before writing.
