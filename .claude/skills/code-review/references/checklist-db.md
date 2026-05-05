# DB / migrations / queries — specialist checklist

You are reviewing diff hunks under `src/db/**`. Apply the rubric in `severity-rubric.md`. Cite `file:line` for every finding. Quote ≤ 2 lines as evidence. Suggest a concrete fix in ≤ 4 lines. Cap output at 8 findings.

## Context to keep in mind

- DB driver: `better-sqlite3` (synchronous API — no `async/await` for queries).
- WAL mode is enabled in `src/db/connection.ts`. Don't change it without an explicit reason.
- Prepared statements are cached at module level; the cache is reset by `closeDb()`. Tests rely on this for isolation.
- Schema lives in `src/db/schema.ts`; migrations in `src/db/migrations.ts` are sequential numbered.
- The repo already has 7 migrations. Migration 005 uses `DELETE … GROUP BY` for dedup — that's a known pattern to scrutinize, not a green light to copy.

## Rules

### CRITICAL — flag at confidence ≥ 4

| # | Rule | Bug shape |
|---|---|---|
| C1 | No string interpolation into SQL — use named `@param` binding. | `db.prepare(\`SELECT ... WHERE id = '${id}'\`)` |
| C2 | Migrations preserving existing data must have a backfill step. | New `NOT NULL` column without `DEFAULT` and no `UPDATE` to fill nulls. |
| C3 | `DELETE` without a `WHERE` clause anywhere except a documented "wipe" path. | Loose `DELETE FROM events;` outside `/api/clear`. |
| C4 | Schema in `schema.ts` and the latest migration must agree. | Column added to `schema.ts` but no migration adds it. |

### HIGH — flag at confidence ≥ 6

| # | Rule | Bug shape |
|---|---|---|
| H1 | Migrations are idempotent: running the migration runner twice must succeed. | `ALTER TABLE x ADD COLUMN y` without `IF NOT EXISTS` guard or a "skip if migration N already applied" check. |
| H2 | New prepared statement is registered with the cache and reset by `closeDb()`. | New module-scope `db.prepare(...)` not wired into the cache reset path. |
| H3 | `ON CONFLICT` upsert covers all unique constraints. | Conflict resolution on `id` only when there's also a `(session_id, sequence_num)` unique index. |
| H4 | New query in a hot path (per-event, per-session-list) uses an index. | `WHERE` on a column with no index, in code path that runs ≥ N times per session import. |
| H5 | Transaction wraps multi-statement writes that must succeed atomically. | Loop calling `INSERT` outside a transaction → partial state on error. |
| H6 | `closeDb()` cleanup runs on test fixtures that opened a DB. | Test creates a DB in tmpdir but doesn't close, leaving WAL/SHM files. |

### MEDIUM — flag at confidence ≥ 7

- M1: Query result types match the TS interface — no implicit `any` from `db.prepare(...).get()`.
- M2: Migrations have a one-line comment explaining *why*, not just what. (CLAUDE.md: actionable docs.)
- M3: Index added without a corresponding query that benefits — risk of dead weight.
- M4: New query uses `*` instead of an explicit column projection (esp. for `SESSION_LIST_COLUMNS` style projections).

### LOW — flag at confidence ≥ 8

- Naming: query function name doesn't reflect what it returns (`getSession` returning a list).
- Magic literals: thresholds (e.g., compaction `> 0.30`) without a comment.

## Skip rules

In addition to the global skip rules in `severity-rubric.md`:

- Don't flag pragma changes that match the existing list in `connection.ts` (the pragma set is project policy).
- Don't flag a query as "could be paginated" unless there's evidence the dataset can grow unbounded — the project is local-only and bounded by `~/.claude/projects/`.
