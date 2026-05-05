# Output template

Print findings to stdout in this exact format. The user reads this directly.

## Skeleton

````
## Code review: <head-ref> vs <base-ref>
**Scope:** N files changed (+X / −Y lines), surfaces: <comma-list>
**Specialists run:** <comma-list>  •  **Adversarial pass:** ✓
**Suppressed:** N below threshold (skip rules dropped M before that)

### Scope check
<one paragraph; OMIT this entire section if scope was fine>

### CRITICAL (N)
[CRITICAL] (confidence: X/10) path/to/file.ts:LINE
  <one-sentence problem statement>
  Why: <≤2 quoted lines from the file>
  Fix: <≤4 lines of concrete patch sketch>

### HIGH (N)
[HIGH] (confidence: X/10) path/to/file.ts:LINE
  <…>

### MEDIUM (N) — collapsed; expand with --verbose
<list, single-line per finding unless --verbose passed>
- [MEDIUM] (8/10) path/to/file.ts:LINE — <one-sentence statement>
- …

### LOW (N) — collapsed
- [LOW] (8/10) path/to/file.ts:LINE — <one-sentence statement>
- …

### Notes
- <merged-finding callout: "this finding showed up in both db and api specialists; promoted to HIGH">
- <related-files callout: "the same issue applies to lines X, Y in the same file">
- <empty if nothing notable>
````

## Rules for rendering

- **Skip empty bands.** If `CRITICAL (0)` — omit the section entirely. Don't print empty headers.
- **Always render `### Scope check` first** (above CRITICAL) when it has content. Scope concerns dominate everything else.
- **Sort within a band by confidence descending.** Highest-confidence finding first.
- **The first sentence of each finding is the problem, not the fix.** "Migration drops `risk_score` without a backfill" — not "Add a backfill before dropping `risk_score`."
- **Fix line is concrete.** A code sketch is better than prose. Two lines of pseudo-diff beats a paragraph of "consider doing X".
- **No emoji.** Not in the header, not in findings, not in the footer.
- **No closing message.** After the last finding, stop. Don't add "Let me know if you want me to fix any of these" — the user already knows the skill is read-only.

## Example output

```
## Code review: claude/hopeful-franklin-98f396 vs main
**Scope:** 4 files changed (+82 / −15 lines), surfaces: db, api
**Specialists run:** db, api  •  **Adversarial pass:** ✓
**Suppressed:** 2 below threshold (skip rules dropped 5 before that)

### CRITICAL (1)
[CRITICAL] (confidence: 9/10) src/db/migrations.ts:118
  Migration 008 drops `risk_score` and recreates with NOT NULL but no backfill.
  Why: existing rows hit `NOT NULL` violation:
    `ALTER TABLE sessions DROP COLUMN risk_score;`
    `ALTER TABLE sessions ADD COLUMN risk_score REAL NOT NULL;`
  Fix: add a backfill step:
    `UPDATE sessions SET risk_score = 0.0 WHERE risk_score IS NULL;`
    Or change to `NOT NULL DEFAULT 0.0`.

### HIGH (1)
[HIGH] (confidence: 7/10) src/server/routes/sessions.ts:54
  `parseFloat(maxRisk)` accepts NaN without rejecting the request.
  Why: existing pattern is parseFloat + Number.isFinite (see line 41 of same file).
  Fix: `if (!Number.isFinite(parsed)) return c.json({error:'invalid maxRisk'}, 400);`

### Notes
- The db and api specialists both flagged routes that consume the new `risk_score`
  column without a fallback. After the migration is fixed, the api finding above
  resolves automatically.
```

That's the whole output. Stop after `### Notes` (or after the last finding if Notes is empty).
