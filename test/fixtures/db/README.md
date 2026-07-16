# Versioned DB snapshots

Binary SQLite snapshots of historical schema versions, one file per captured
version (`v1.sqlite`, `v9.sqlite`, `v15.sqlite`). They exist so
[`test/db/migration-upgrade-path.test.ts`](../../db/migration-upgrade-path.test.ts)
can restore a genuinely-old database and drive it through the full forward
migration chain (`src/db/migrations.ts`, currently 17 sequential migrations),
asserting no data loss, correct backfills, a final schema matching a fresh
`:memory:` reference, and idempotency.

Unlike the JSONL corpus one directory up, these are opaque binaries — the PII
gate (`test/fixtures/pii-gate.test.ts`) scans only `*.jsonl`, so it does **not**
check these files. The synthetic-data rule below is therefore enforced by hand
and by review, not by a gate.

## Why binaries, and why a frozen v1 schema

You cannot build an honestly-old snapshot from current code. `INITIAL_SCHEMA`
in `src/db/schema.ts` is **consolidated, not frozen**: it already declares the 8
columns migrations 016/017 add (their `ALTER`s are kept idempotent by
`tableHasColumn` guards). A snapshot built from `INITIAL_SCHEMA` would carry
those columns, so the add-column migration path would no-op on restore and never
get exercised.

The generator `scripts/make-db-fixture.mts` therefore holds ONE frozen artifact,
`HISTORICAL_V1_SCHEMA` — `INITIAL_SCHEMA` minus exactly those 8 consolidated
columns (sessions: `total_input_tokens_billed`, `total_cache_write_5m_tokens`,
`total_cache_write_1h_tokens`, `cost_estimate_usd`; agent_relationships:
`cache_read_total`, `cache_write_5m_total`, `cache_write_1h_total`, `model`). It
builds each version-N snapshot by applying that frozen v1 base, running the REAL
migrations `2..N` on top (via a `_migrations` skip-marker trick keyed off
`LATEST_MIGRATION_ID`), trimming the marker set back to exactly `1..N`, then
seeding synthetic data. So a restored v1 genuinely lacks the later columns and
the guarded ALTERs really add them.

Because the migration marker rows use `datetime('now')` DEFAULTs, regeneration
is **not byte-identical**. The committed binary is the source of truth; the
generator is a reproducibility / bootstrap tool, not a build step.

## Which versions, and why these

- **v1** — the oldest schema, before any consolidated column existed (also holds
  duplicate `agent_relationships` rows so migration 005's dedup is exercised).
- **v9** — an intermediate captured just before migration 010's session-pills
  backfill (`invocations` / `started_with`).
- **v15** — an intermediate captured just before the migration 016/017
  cache-split + cost backfill.

Oldest plus two backfill-boundary intermediates give the upgrade test coverage
over the migrations that transform data, not just add columns.

## Updating the snapshots (when you add migration N+1)

When you land a new migration, capture a `v<N>` snapshot of the previous HEAD
schema version so the upgrade path over it stays tested:

1. Add `N` to the `versions` captured in `scripts/make-db-fixture.mts` (the
   `buildSnapshot(...)` calls in `main()`), and extend `seed()` if the new
   boundary needs representative data.
2. Regenerate every committed binary:

   ```bash
   npx tsx scripts/make-db-fixture.mts
   ```

   This rewrites `test/fixtures/db/{v1,v9,v15,...}.sqlite`.
3. Add the new version to the `CASES` list in
   `test/db/migration-upgrade-path.test.ts` and run `npm test`.

The `.sqlite` files are force-tracked past the repo-wide `*.sqlite` `.gitignore`
rule by the `!test/fixtures/db/*.sqlite` negation, so `git add` picks them up
normally.

## Synthetic-data requirement

Seed data must be **fully synthetic** — no real filesystem paths, emails, or
machine identifiers (the generator's `seed()` uses `/tmp/...` paths and
`s-*` / `agent-*` ids). This mirrors the fixture-corpus pseudonymization rule in
[`../README.md`](../README.md). The PII gate does not scan these binaries, so
keep the seed synthetic by hand and check it in review.
