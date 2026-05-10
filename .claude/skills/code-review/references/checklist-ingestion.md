# Ingestion pipeline — specialist checklist

You are reviewing diff hunks under `src/ingestion/**` and `src/analysis/**`. Apply the rubric in `severity-rubric.md`. Cite `file:line` for every finding. Cap output at 8 findings.

## Pipeline shape (reminder)

```
JSONL → jsonl-parser → thinking-extractor → token-tracker → DB
```

Two files compute things that have to stay in sync: `src/ingestion/thinking-extractor.ts` (events, tool merging, agent IDs) and `src/ingestion/transcript-importer.ts` (session aggregates, event records, per-event `context_pct`). When one changes, check the other.

## Rules

### CRITICAL — flag at confidence ≥ 4

| # | Rule | Bug shape |
|---|---|---|
| C1 | `effectiveContextTokens` includes ALL three context fields: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. | Code computes `input_tokens + cache_read_input_tokens` only — produces phantom compactions on cache rotation. |
| C2 | Reimport is idempotent. Same JSONL → same DB state; different runs don't multiply rows. | New code path adds rows without checking for existing `(session_id, sequence_num)`. |
| C3 | Streaming preserved: no `JSON.parse(fs.readFileSync(file))` on the whole file. | Bulk load of a large transcript breaks memory bounds. |

### HIGH — flag at confidence ≥ 6

| # | Rule | Bug shape |
|---|---|---|
| H1 | Compaction detection threshold (`> 30%` input drop) unchanged without a fixture-backed reason. | New magic number replacing 0.30 with no test in `test/ingestion/`. |
| H2 | New event types are wired through BOTH `thinking-extractor.ts` AND `transcript-importer.ts`. | Event type added in extractor but importer's `buildEventRecords` doesn't handle it → silent drop. |
| H3 | Agent ID assignment from tool names handles the existing patterns (`Task`, `Agent`, custom subagent names). | New tool name regex narrower than what the pipeline already accepts → orphaned agent_id values. |
| H4 | `isSubagentFile()` heuristic backed by a unit test before being changed. | Path detection changed without a fixture test asserting both true and false cases. |
| H5 | Session aggregates (`computeAggregates`) consume the same token field as `token-tracker.ts`. | `total_input_tokens` summed from a different field than `effectiveContext` → DB and chart diverge. |

### MEDIUM — flag at confidence ≥ 7

- M1: New error path in the parser logs but doesn't surface — caller can't tell ingestion partially failed.
- M2: ISO 8601 timestamp string written as `Date` object (CLAUDE.md: timestamps are ISO 8601 strings).
- M3: `parsedEvent` shape change without updating the type in `src/shared/types.ts`.
- M4: New filesystem read inside a tight loop (re-reading per-line) — should be hoisted.

### LOW — flag at confidence ≥ 8

- Naming: extractor function called `parseX` that also writes to DB.
- Comment claims "skip empty lines" but code doesn't.

## Skip rules

In addition to the global skip rules in `severity-rubric.md`:

- Don't flag generic "you should add validation" on JSONL fields unless the field is then used to compute something (path, token count, model key) — JSONL is internal trusted data from Claude Code itself.
- Don't flag the `cacheRotation` comment block in `token-tracker.ts` as "explain more" — that's documented at the architectural level in `debug-pipeline/SKILL.md`.
