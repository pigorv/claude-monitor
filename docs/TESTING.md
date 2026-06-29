# Testing Strategy

This is the living test-strategy document for `claude-monitor`. It describes the
*target* shape of our testing — the test pyramid, the quality gates, our coverage
targets, and how to run each layer. Some layers and gates already exist; others are
the intended end-state we are building toward. This document describes the strategy,
not the current completion status of any one piece.

If you are adding tests, follow the level definitions below so tests land in a
predictable place. If you are fixing a bug, see [The regression-test rule](#the-regression-test-rule).

## Philosophy: why this app's pyramid is non-standard

`claude-monitor` is an observability tool, and its core promise is **data
correctness**: the numbers on the dashboard must match the truth in the transcript.
That shapes our testing in ways a typical CRUD web app's pyramid would not:

- **Wrong numbers are silent defects.** The product's value *is* the data. A
  miscomputed token total, context-utilization percentage, compaction boundary, or
  agent attribution looks plausible and ships unnoticed. We therefore over-invest in
  low-level correctness tests (L0) and contract/data-quality tests (L3) for token
  math, context %, compaction detection, and agent attribution.
- **We ingest untrusted, evolving third-party data.** Transcripts are JSONL written
  by Claude Code, whose format drifts over time and across versions. Schema drift is
  our number-one production failure mode, so the contract layer (L3) carries unusual
  weight.
- **We are stateful and migration-heavy.** The app uses SQLite in WAL mode with a
  sequence of schema migrations. Every release must preserve the upgrade path, so we
  need a migration/upgrade safety net (L3).
- **We are cross-platform.** The CLI and server run on Linux, macOS, and Windows
  (terminal handling differs per OS). That demands an OS matrix at the
  non-functional layer (L5).

The result is a pyramid that is heavier than usual in the L0 and L3 bands, with a
deliberately small top.

## The pyramid

```
 L6  Manual / exploratory / release acceptance      (tiny)
 L5  Non-functional: perf, soak, a11y, visual, cross-OS
 L4  E2E — real browser + real CLI + real DB
 L3  Contract / schema / data-quality (JSONL + API + migrations)
 L2  Integration (pipeline, route+DB, CLI process)
 L1  Component / module (frontend render, query layer)
 L0  Unit (token math, parsers, formatters)
```

Tests live under `test/`, mirroring the source areas (`test/analysis/`, `test/cli/`,
`test/db/`, `test/export/`, `test/frontend/`, `test/ingestion/`, `test/server/`,
`test/shared/`). Levels L0–L2 map onto that existing layout; L3–L6 describe the
target design.

### L0 — Unit

- **Purpose:** Verify the smallest pure-logic units in isolation — especially the
  correctness-critical math the product depends on.
- **What belongs here:** Token arithmetic, context-utilization percentage against
  model thresholds, compaction detection (input-token drop logic), JSONL block
  normalization, thinking extraction, formatters, cost computation, and other pure
  functions with no I/O.
- **Tools:** Vitest.
- **Where tests live:** `test/ingestion/` (`jsonl-parser`, `thinking-extractor`,
  `token-tracker`, `edge-cases`), `test/shared/` (`cost`), `test/analysis/`
  (`session-summary`), and the pure-logic frontend specs in `test/frontend/`
  (`ctx`, `markdown`, `model-meta`, `parse-ask-output`, `url-state`).

### L1 — Component / module

- **Purpose:** Verify a single module or rendered component behaves correctly with
  its immediate collaborators stubbed or in-memory.
- **What belongs here:** Frontend component rendering (Preact + HTM rendered to
  string), the query layer against an in-memory or temp SQLite database, and
  self-contained UI helpers that touch DOM/state.
- **Tools:** Vitest with `preact-render-to-string`; better-sqlite3 backed by a temp
  database for query modules.
- **Where tests live:** `test/frontend/` (`components`, `copy-button`, `gantt`,
  `render-snippet`, `selection`, `tool-tags`, `usePersistentState`) and
  `test/db/queries/`.

### L2 — Integration

- **Purpose:** Verify multiple real modules working together across a seam —
  pipeline stages chained, a route talking to a real database, or the CLI run as a
  process.
- **What belongs here:** The end-to-end ingestion pipeline (parser → extractor →
  token tracker → importer), Hono route handlers exercised against a real SQLite
  database, and CLI commands run as a process.
- **Tools:** Vitest; better-sqlite3 with a temp database; Hono app instance; child
  process invocation for CLI specs.
- **Where tests live:** `test/ingestion/` (`transcript-importer`,
  `transcript-watcher`), `test/server/` (`sessions`, `events`, `stats`, `health`,
  `reimport`, `export`, `session-export`, `terminal`), `test/cli/` (`import`,
  `export`, `start-status`), and `test/db/` (`compact-database`, the `migration-*`
  specs, `migrations`).

### L3 — Contract / schema / data-quality

- **Purpose:** Guard the boundaries where we meet untrusted or evolving data, and
  guarantee the database upgrade path. This is the layer that catches schema drift —
  our highest-impact failure mode — before it reaches users.
- **What belongs here:**
  - **JSONL contract:** assertions that the parser tolerates and correctly handles
    real-world transcript shapes, including new/unknown fields and missing optionals.
  - **API contract:** assertions that each `/api/*` response conforms to its agreed
    schema (shape, types, required fields), so the frontend's expectations are pinned.
  - **Migration / upgrade path:** apply migrations forward over a populated database
    representing an older schema version and assert the data survives intact.
  - **Schema-drift canary:** detect when an incoming transcript carries a field or
    structure we have never seen, so drift surfaces as a signal rather than a silent
    miscount.
- **Tools:** Vitest; fixture corpora (see [Fixture-corpus taxonomy](#fixture-corpus-taxonomy));
  schema/shape assertions over API responses.
- **Where tests live (target):** alongside the area each contract belongs to —
  JSONL contract under `test/ingestion/`, API contract under `test/server/`,
  migration/upgrade-path under `test/db/`.

### L4 — End-to-end

- **Purpose:** Verify the whole product works as a user experiences it: a real
  browser driving the real SPA against the real CLI/server and a real database.
- **What belongs here:** Critical user journeys — import a transcript via the CLI,
  start the server, load the dashboard, open a session, and confirm the Timeline /
  Context / Agents tabs render the expected data.
- **Tools:** Playwright driving the built frontend served by the real Hono server,
  with a real SQLite database seeded from fixtures.
- **Where tests live (target):** a dedicated end-to-end suite (for example
  `test/e2e/`), kept deliberately small and focused on the highest-value journeys.

### L5 — Non-functional

- **Purpose:** Verify properties that are not about a single feature's correctness —
  performance, durability, accessibility, visual stability, and cross-platform
  behavior.
- **What belongs here:**
  - **Performance / scale:** ingest and render large transcripts within acceptable
    time and memory bounds.
  - **Soak:** the watcher and server stay healthy over long-running sessions.
  - **Accessibility (a11y):** the dashboard meets baseline a11y expectations.
  - **Visual:** key views do not regress visually.
  - **Cross-OS:** the CLI and server behave correctly on Linux, macOS, and Windows
    (terminal handling in particular).
- **Tools (target):** Playwright for a11y/visual; a benchmarking harness for
  perf/scale; the CI OS matrix for cross-platform runs.
- **Where tests live (target):** a non-functional suite (for example `test/perf/`
  and `test/a11y/`), run on a slower cadence than the per-PR suite.

### L6 — Manual / exploratory / release acceptance

- **Purpose:** Catch what automation cannot — judgment calls about whether the
  product actually feels right — and sign off a release.
- **What belongs here:** Exploratory testing of new features, manual release
  acceptance against the packaged tarball, and final human sign-off.
- **Tools:** A human, the packaged build, and a release checklist.
- **Where tests live:** Not code; this is a documented manual process performed at
  release time.

## Quality gates

We run tests in three tiers, each gating a different moment in the lifecycle. The
PR tier is blocking; the others run on a schedule or at release.

### PR (blocking)

The target per-PR gate runs, in order:

1. **Typecheck** — `npm run typecheck`
2. **Build** — `npm run build`
3. **L0–L3** — the Vitest suite plus contract/schema/data-quality checks
4. **E2E smoke** — a minimal subset of the L4 journeys
5. **Coverage threshold** — enforced against the targets below
6. **Changelog entry** — a `## [Unreleased]` entry is present for the change

> **What CI actually runs today:** `.github/workflows/ci.yml` runs
> `checkout → setup-node (22) → npm ci → npm run typecheck → npm run build → npm test`
> on push and pull request to `main`. The `npm test` step covers the L0–L2 Vitest
> suite. The remaining items in the target PR gate — the L3 contract layer, the E2E
> smoke subset, the coverage threshold, and the changelog check — are part of the
> intended gate and are not yet wired into `ci.yml`.

### Nightly

Run on a schedule, broader and slower than the PR gate:

- Full E2E (L4)
- Performance / scale (L5)
- Accessibility (L5)
- Cross-OS matrix (L5)
- Schema-drift canary (L3)

### Release

Run when cutting a release (tag `v*`, see `.github/workflows/release.yml`):

- The full pyramid (L0–L6)
- Packaged-tarball acceptance — install and run the published artifact
- Migration upgrade-path verification
- Manual sign-off (L6)

## Coverage targets

Coverage is **tiered** — the correctness-critical core is held to a higher bar than
the repo as a whole, because that is where silent defects do the most damage.

| Scope | Target |
| --- | --- |
| Correctness-critical modules | **≥ 90% line + branch** |
| Overall repo | **≥ 80% line** |

The correctness-critical modules are the ones whose output appears as a number or a
boundary on the dashboard:

- `src/ingestion/jsonl-parser.ts` — JSONL parsing and normalization
- `src/ingestion/thinking-extractor.ts` — event extraction
- `src/ingestion/token-tracker.ts` — token math, context utilization %, compaction detection
- `src/analysis/` — compaction detection, session summary, agent efficiency/attribution, session linking

> **Enforcement is a follow-up.** These thresholds describe the target. Wiring
> coverage measurement and threshold enforcement into CI is a separate, not-yet-done
> piece of work; the numbers above are the bar we are building toward, not a gate
> that fails a PR today.

## Fixture-corpus taxonomy

Tests are only as trustworthy as the transcripts they run against. Fixtures live
under `test/fixtures/`, grouped into seven taxonomy directories so each level can
draw on representative inputs:

- **`happy/`** — small, well-formed transcripts for the common case
  (`sample-session.jsonl`, `sample-agent-transcript.jsonl`). The baseline for L0–L2.
- **`legacy-format/`** — loose / older shapes the parser must still ingest (no
  top-level `version`, bare-string `message.content`, absent `usage`).
- **`corrupt/`** — off-spec content the importer must degrade on rather than crash
  (truncated final line, mid-file malformed JSON, raw non-UTF8 bytes), exercised by
  the L3 contract layer.
- **`plan-impl-pair/`** — a plan + implementation session pair whose plan text
  matches, so the session-linker pairs them.
- **`large/`** — a large transcript with an authentic token curve, for the L5
  performance/scale tests.
- **`compaction/`** — a slice spanning a real >30% effective-context drop, so
  compaction-boundary detection fires.
- **`subagent/`** — a parent transcript plus its child subagent file, for agent
  attribution and the parent/child relationship.

See [`test/fixtures/README.md`](../test/fixtures/README.md) for the full per-dir
detail — which fixtures are hand-authored vs **derived** from real sessions, how to
add one, and how to re-derive via `scripts/derive-fixture.mts`.

**Pseudonymization is enforced, not just expected.** Any fixture derived from a real
session is produced only through the sanitizer (`scripts/derive-fixture.mts`), and
every `test/fixtures/**/*.jsonl` is scanned by the PII gate
(`test/fixtures/pii-gate.test.ts`, part of `npm test`), which fails the build on a
real home path, non-synthetic `/home/<seg>/`, non-`@example.*` email, or this
machine's home path / username.

## The regression-test rule

**Every bug fix ships a regression test.** When you fix a defect, add a test that
fails before your fix and passes after it. Put it at the lowest level that
reproduces the bug — usually L0 or L3 for data-correctness defects — so the test is
fast and pins the exact behavior. A bug fix without an accompanying test is not
considered complete.

## How to run each layer

Commands below are real `npm` scripts where one exists. Layers without a command
today are marked **planned**: do not invent a command for them.

| Layer | How to run |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| L0 Unit | `npm test` (runs the full Vitest suite) |
| L1 Component / module | `npm test` |
| L2 Integration | `npm test` |
| Token-style lint | `npm run lint:tokens` |
| L3 Contract / schema / data-quality | **planned** |
| L4 E2E | **planned** |
| L5 Non-functional (perf, a11y, visual, cross-OS) | **planned** |
| L6 Manual / release acceptance | manual process (see [L6](#l6--manual--exploratory--release-acceptance)) |
| Coverage measurement / threshold | **planned** |

To run a single test file:

```bash
npx vitest run test/<area>/<name>.test.ts
```
