# Hono server / CLI / API — specialist checklist

You are reviewing diff hunks under `src/server/**`, `src/cli/**`, and `src/index.ts`. Apply the rubric in `severity-rubric.md`. Cite `file:line` for every finding. Cap output at 8 findings.

## Context

- HTTP framework: Hono with `@hono/node-server`. Routes live in `src/server/routes/`.
- Existing input-validation idiom: `parseFloat(...)` then `Number.isFinite(...)`. Mirror that.
- The server runs locally on the user's machine; threat model is "untrusted JSONL on disk", not "untrusted internet caller".
- Destructive endpoints (`/api/clear`, `/api/reimport`) require explicit confirmation — keep that invariant.
- Hook scripts have a < 50ms budget per CLAUDE.md.

## Rules

### CRITICAL — flag at confidence ≥ 4

| # | Rule | Bug shape |
|---|---|---|
| C1 | Filesystem-traversing handlers reject symlinks and bound recursion depth. | `/api/reimport`-style code that recurses via `readdir` without `lstat` symlink check or depth limit → loop or escape. |
| C2 | Destructive endpoint requires explicit confirmation param. | New `DELETE` or destructive `POST` with no `?confirm=true` (or equivalent) gate. |
| C3 | Path parameters from URL aren't passed unsanitized to filesystem APIs. | `path.join(BASE, c.req.param('name'))` with no `..` normalization check. |
| C4 | No string concat into shell commands (esp. `child_process.exec`). | `exec(\`open ${path}\`)` with user-controlled `path`. |

### HIGH — flag at confidence ≥ 6

| # | Rule | Bug shape |
|---|---|---|
| H1 | Numeric query params validated with `Number.isFinite` after `parseFloat`/`parseInt`. | `parseFloat(req.query('maxRisk'))` used directly — NaN sneaks through. |
| H2 | Enum-shaped query params validated against an allowlist. | `status` accepted as freeform string and passed to a `WHERE status = ?` query. |
| H3 | New endpoints have at least one route-list test (200 + 4xx). | `routes/foo.ts` added with no `test/server/foo.test.ts`. |
| H4 | Error responses don't include stack traces or absolute paths. | `c.json({error: err.stack}, 500)` leaking `/Users/Ihor_Prysiazhnyi/...`. |
| H5 | Route handlers don't mutate module-scope state — go through `src/db/queries/`. | Handler writes directly to a cache map outside any query function. |
| H6 | New CLI command has a usage string and exits non-zero on error. | `commander` action returning silently on a thrown promise. |
| H7 | Hook scripts (under `hooks/`) stay standalone and fast. | Hook adds `import` from main package or starts a child process per call. |

### MEDIUM — flag at confidence ≥ 7

- M1: Response shape change to an existing endpoint without updating the frontend type or API client.
- M2: New endpoint missing CORS / content-type considerations if cross-origin (rare here, but check).
- M3: New endpoint accepts `POST` with a JSON body but doesn't validate body schema.
- M4: Pagination defaults are reasonable (`limit` capped, `offset` defaulted).

### LOW — flag at confidence ≥ 8

- Route handler with no logging on the error branch — hard to debug from local logs.
- Inconsistent route naming (`/api/sessions/:id/events` vs new `/api/getEvents/:id`).

## Skip rules

In addition to the global skip rules in `severity-rubric.md`:

- Don't flag missing auth/CSRF — this server binds to localhost by design.
- Don't flag rate limiting — same reason.
- Don't flag API versioning — single-author project, breaking changes go in CHANGELOG.
