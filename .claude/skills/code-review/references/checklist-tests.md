# Tests / Vitest — specialist checklist

You are reviewing diff hunks under `test/**` (and any `**/*.test.ts` collocated with source). Apply the rubric in `severity-rubric.md`. Cite `file:line` for every finding. Cap output at 8 findings.

## Context

- Test runner: Vitest. Pool: `forks`. `fileParallelism: false` → tests run sequentially in process-isolated forks.
- Layout: `test/<surface>/<file>.test.ts` mirrors `src/<surface>/<file>.ts`.
- Filesystem fixtures: `tmpdir()` + cleanup in `afterEach`. No shared global fixtures.
- DB tests call `closeDb()` to reset the singleton between cases.
- Mock JSONL fixtures are inline string arrays in the test file — no separate fixture files for trivial cases.
- Test timeout: 30s. If you need longer, the test is too coarse.

## Rules

### HIGH — flag at confidence ≥ 6

| # | Rule | Bug shape |
|---|---|---|
| H1 | New public function or route has at least one test. | New exported function in `src/ingestion/foo.ts` with no `test/ingestion/foo.test.ts`. |
| H2 | A bug fix has a regression test — it fails without the fix and passes with it. | Diff fixes a function and updates no tests. |
| H3 | DB test calls `closeDb()` in `afterEach` (or equivalent). | Test creates DB in tmpdir, mutates singleton, doesn't reset → leaks into next test. |
| H4 | tmpdir cleanup runs even on test failure. | `afterEach` does cleanup conditionally on success → leftover dirs accumulate. |
| H5 | Test does not mutate global state shared with other tests. | Test sets `process.env.X` without restoring, or writes to a project-relative path. |
| H6 | Test file path mirrors the source file. | New test in `test/utils.test.ts` for code in `src/db/queries/sessions.ts` — should be `test/db/queries/sessions.test.ts`. |

### MEDIUM — flag at confidence ≥ 7

- M1: Test assertion is `expect(x).toBeTruthy()` for something with a known shape — should be `toEqual(...)`.
- M2: Test name doesn't describe the behavior under test ("works", "ok", "test 1").
- M3: Setup function does too much — multiple unrelated arrange steps in one fixture.
- M4: New JSONL fixture inlined as 50+ lines of string — should move to a fixture file.
- M5: Use of `vi.mock(...)` for a module the test could exercise directly — mocks the unit under test by accident.

### LOW — flag at confidence ≥ 8

- Repeated `expect(x).toBe(undefined)` after `expect(x).toBeUndefined()` already exists in the file.
- Skipped test (`it.skip`) without a comment explaining why.
- Magic literals in assertions where a named constant would explain the source.

## Skip rules

In addition to the global skip rules in `severity-rubric.md`:

- Don't flag missing `describe` blocks — both `describe`-wrapped and flat tests are present in the codebase.
- Don't flag use of `it` vs `test` — both styles exist.
- Don't flag the absence of property-based testing — the project uses example-based tests by convention.
- Don't flag missing Playwright tests for frontend changes — Playwright is invoked manually via the `playwright-cli` skill, not as part of the test suite.
