# Fixture corpus

The golden JSONL corpus the test suite runs against. Fixtures are grouped into
seven taxonomy directories so each kind of input — happy-path, legacy shapes,
corrupt bytes, plan/impl pairs, large transcripts, compaction, subagents — has a
representative sample to pin behavior against.

Every `*.jsonl` file under this directory is checked by the **PII gate**
(`pii-gate.test.ts`, runs as part of `npm test`). See [The PII gate](#the-pii-gate)
below for exactly what it enforces.

## Taxonomy

| Dir | Purpose | Example file | Origin |
| --- | --- | --- | --- |
| `happy/` | Small, well-formed transcripts for the common case (a parent session and an agent transcript). | `sample-session.jsonl` | hand-authored |
| `legacy-format/` | Loose / older shapes the parser must still ingest: no top-level `version`, a bare-string `message.content`, and an assistant message with no `usage`. | `no-version.jsonl` | hand-authored |
| `corrupt/` | Off-spec content the importer must degrade on rather than crash: a truncated final line, mid-file malformed JSON, and raw non-UTF8 bytes. | `truncated.jsonl` | hand-authored |
| `plan-impl-pair/` | A plan session and an implementation session whose plan text matches, so the session-linker pairs them. | `plan-session.jsonl`, `impl-session.jsonl` | hand-authored |
| `large/` | A large transcript (~448 KB) with an authentic token curve, for performance/scale tests. | `large-session.jsonl` | **derived** |
| `compaction/` | A slice (~433 KB) spanning a real >30% effective-context drop, so `is_compaction` fires. | `compaction-session.jsonl` | **derived** |
| `subagent/` | A parent transcript plus its child subagent file, so the importer attributes the subagent to its parent. | `<sessionId>.jsonl` + `<sessionId>/subagents/agent-*.jsonl` | **derived** (`--subagents`) |

"hand-authored" = written by hand from synthetic data only. "derived" = produced
from a real session by running it through the sanitizer via
`scripts/derive-fixture.mts` (see below). No raw real transcript content is ever
committed.

## Pseudonymization requirement

Anything in this corpus must be safe to share publicly:

- **Derived fixtures** (any fixture built from a real session) MUST be produced
  through `scripts/derive-fixture.mts`, which runs the real export sanitizer over
  every line. Never hand-edit real transcript content into a fixture.
- **Hand-authored fixtures** MUST use synthetic data only — `/tmp/...` paths and
  `uuid-*` / `legacy-*` / `corrupt-*` / `plan-*` / `impl-*` style ids. Never a real
  home path, real email, or real machine identifier.

## Re-deriving a fixture (`scripts/derive-fixture.mts`)

```bash
npx tsx scripts/derive-fixture.mts <srcParent.jsonl> <destPath.jsonl> [--max-lines N] [--subagents]
```

The harness reads the source transcript line-by-line, runs each line through the
export sanitizer (`createSanitizer` / `sanitizeLine` in
`src/export/transcript-sanitizer.ts`), writes only the non-null output, and prints
a counts-only audit. Flags:

- `--max-lines N` — stop after N source lines (used to trim `large/` and
  `compaction/` to a manageable size).
- `--subagents` — also discover the parent's `<sess>/subagents/agent-*.jsonl`
  children, sanitize them with the same sanitizer instance (so pseudonyms stay
  coherent), and write them into the layout the importer expects:
  `<destStem>/subagents/<child>.jsonl`.

The **source transcript path is a CLI argument and is never committed** — only the
sanitized output lands in the repo.

### What the sanitizer preserves vs scrambles

So you know what a derived fixture looks like:

- **Pseudonymized** — filesystem paths, `cwd`, and `gitBranch`.
- **Scrambled** to `[a-z0-9 ]` gibberish — all free text, message content, and
  `thinking`.
- **Dropped** — `file-history-snapshot` lines and unknown line types; malformed
  JSON is replaced with a same-length garbage string.
- **Kept verbatim** — `uuid`, `parentUuid`, `sessionId`, tool ids, `usage`,
  `model`, `isSidechain`, `subagent_type`, and `agentType`. These are
  structural / measurement / attribution fields, not PII — which is why derived
  fixtures still contain opaque UUIDs and agent-type labels.

## Adding a fixture

1. Decide which taxonomy dir it belongs in (add a new one only if no existing
   category fits — and update `pii-gate.test.ts`'s `TAXONOMY_DIRS` if you do).
2. **Hand-authored?** Write it with synthetic data only (see the requirement
   above). **Derived from a real session?** Run `scripts/derive-fixture.mts` — do
   not hand-edit real content in.
3. Run `npm test`. The PII gate scans your new file automatically; a leak fails
   the build.

## The PII gate

`pii-gate.test.ts` runs in the normal `npm test` (the `unit` project). It
recursively scans every `test/fixtures/**/*.jsonl` (read as latin1, so the
non-UTF8 fixture doesn't throw) and **fails** on any of:

- a `/Users/` path occurrence;
- a `/home/<seg>/` path whose `<seg>` is not in the synthetic allowlist
  `{user, dev, tmp, test, runner, example}`;
- an email address whose domain is not `@example.*`;
- this machine's `os.homedir()` path or `os.userInfo().username` (the username
  check is skipped for short or generic/CI usernames to avoid false positives).

It also asserts that **each of the seven taxonomy dirs contains at least one
`.jsonl`**. Opaque UUID / session-id strings are intentionally allowed — they are
not PII and the sanitizer keeps them on purpose.
