# Severity × confidence rubric

Every finding gets a **severity band** and a **confidence score (1–10)**. Findings only appear in the report if their confidence clears the band's threshold.

## Bands

### CRITICAL — show if confidence ≥ 4

Real, concrete harm. Pick this if at least one of:

- Exploitable security flaw (SQL injection via concat, command injection, path traversal that escapes intended scope, XSS in user-rendered HTM template, auth bypass).
- Data loss or corruption (migration that drops a column without a backfill, `DELETE` without `WHERE`, race that double-writes).
- Crash on common input (NPE on `undefined` from a parsed JSONL field, unhandled rejection in a hot path).
- Race with a concrete reproducer described in 1–2 sentences.

CRITICAL always appears in the report regardless of `--min-severity`.

### HIGH — show if confidence ≥ 6

Real bug or broken contract that won't crash but will mislead the user. Pick if:

- Wrong number computed (e.g., effective context excludes `cache_creation_input_tokens`, off-by-one in compaction detection).
- API response shape changes break an existing frontend caller.
- Migration is correct but not idempotent (running twice fails).
- Performance regression with measurable impact (added N+1 query, missing index for a query that's now in a loop).
- New public API (route, exported function, CLI flag) lacks any test.
- Hook script slower than the 50ms budget noted in CLAUDE.md.

HIGH always appears in the report regardless of `--min-severity`.

### MEDIUM — show if confidence ≥ 7

Possible footgun, edge case without test, code that will hurt in 6 months but works today. Pick if:

- Edge case left untested (empty input, malformed JSONL line, transcript without `usage`).
- Naming that contradicts the type (a function called `getX` that mutates).
- Magic number without a comment explaining the source (e.g., a new compaction threshold).
- Reused identifier shadows an outer scope.
- Error message that doesn't tell the user what to do (CLAUDE.md: "Error messages should be actionable").

### LOW — show if confidence ≥ 8

Style with a clear rationale, micro-refactor, comment phrasing. Pick if:

- Comment explains what the code does (already obvious from identifiers) instead of why.
- Repeated literal that should be a constant.
- Inconsistency with the immediate surroundings (existing 5 functions use `const`, new one uses `let`).

LOW is the bar for "would I bother typing this if I were reviewing on GitHub?" If the answer is "probably not, but technically…" — that's LOW, and the threshold is intentionally tight.

## Skip rules (drop BEFORE scoring)

Drop the finding entirely. Don't even count it in suppressed totals. These aren't bugs; they're noise.

1. **TypeScript-strict catchable.** This repo's `tsc --noEmit` runs in CI as the linter. If `tsc` would catch it, don't report it.
2. **Untouched lines.** Issue is on a line not in the diff, AND the diff doesn't break that line. (If a renamed function ripples to a non-touched call site that now fails — that IS in scope.)
3. **Pre-existing project pattern.** Same pattern in 3+ unrelated files in `src/` or `frontend/src/`. The user chose this; don't relitigate it on the new occurrence.
4. **Style without a rule.** No ESLint config exists. Don't flag formatting, naming aesthetics, import order, or whitespace.
5. **Conventional log/print added during debugging.** A `console.log` in a CLI command is fine if the rest of that command also logs. A `console.log` in production code is HIGH (not silently suppressed).

## Confidence calibration

Score honestly. Score low when you should.

| Score | Meaning | Test |
|---|---|---|
| 9–10 | I can show the bug with a reproducer | "If I wrote a test, it would fail." |
| 7–8 | Reading the code, the bug is clearly there | "The fix is unambiguous; one diff resolves it." |
| 5–6 | Pattern smells; I'd want to verify | "I'd ask in PR review whether the author thought about this case." |
| 3–4 | Theoretical concern, low likelihood | "Possible, but I'd be surprised." |
| 1–2 | Hunch, no real evidence | "I can't articulate why this is wrong." |

A finding scored ≤ 4 only survives if it's CRITICAL — everything else gets suppressed. **When in doubt between two scores, pick the lower one.** False positives erode trust faster than false negatives.

## Suppression footer

The report's footer reports counts in this exact format:

```
**Suppressed:** N below threshold (skip rules dropped M before that)
```

So the user knows the skill ran fully even when the report is short.
