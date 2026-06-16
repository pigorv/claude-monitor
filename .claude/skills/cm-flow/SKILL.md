---
name: cm-flow
description: One-command issue-to-implementation workflow. Use when the user invokes /cm-flow, says "dev flow", asks to work on a GitHub issue end to end (analyze → design → tasks → implement), or wants to resume or continue a previous cm-flow run (an in-progress .work/ tracker). Drives intake (GH issue or free-text) → clarifying interview → design doc (approval gate) → task tracker (approval gate) → sequential subagent implementation loop with one reviewer pass per task. Artifacts live in the target repo's untracked .work/<id>/ directory.
---

# cm-flow: Issue → Design → Tracker → Implementation

One orchestrator, two human gates, sequential subagent loop. All state lives in
the artifacts under `.work/<id>/` — every invocation re-reads them and continues
from where things stand. Never push, never open PRs, never commit `.work/` files.

Skill file locations (this folder):
- `templates/design.md`, `templates/tracker.md` — artifact skeletons
- `prompts/implementer.md`, `prompts/reviewer.md` — subagent prompt-packet templates

## Invocation → state dispatch

| Input | Action |
|---|---|
| `/cm-flow <issue URL or #N>` | New run from a GitHub issue |
| `/cm-flow "<free text>"` | New run from a manual request |
| `/cm-flow` (bare) | Resume (see below) |

Resume logic, in order:
1. `.work/*/tracker.md` exists → read frontmatter `state:` and continue that phase
   (`tracking` → re-present Gate 2; `implementing` → loop; `done` → report complete).
   Before continuing, compare `git branch --show-current` with frontmatter `branch:`;
   if different, check that branch out; if it no longer exists, stop and ask.
   Multiple trackers → list them (id, title, state) and ask which one.
2. Else `.work/*/design.md` exists → resume at Gate 1 (re-read the file first —
   the user may have edited it). Locate this run's branch (`git branch --list '*<id>*'`)
   and check it out before continuing; if none exists yet, redo Intake step 4.
3. Else → ask what to work on.

Always re-read artifacts at the start of a phase rather than trusting conversation
memory; the user may have hand-edited them. Hand edits are a supported feature.

## Phase: Intake

1. **Analyze input.** GitHub issue: `gh issue view <N> --comments`. Maintainer and
   triage comments are authoritative guidance — they can override the issue body.
   Free text: use as given.
2. **Work id:** `gh-<N>` for issues, short kebab-case slug for free text.
3. **Workspace:** `mkdir -p .work/<id>`.
4. **Feature branch:** Require a clean working tree — if dirty, stop and ask the
   user how to proceed. Then: `git fetch` and create `feat/<id>-<title-slug>` for issues or
   `feat/<id>` for free-text runs (`fix/` instead of `feat/` for bugs) from the
   up-to-date default branch. If a branch for
   this id already exists, check it out and continue on it.
5. **Code research:** Locate the modules/files the change will touch; read enough
   to ground the design in real `file:line` references.
6. **Verify command:** Detect the repo's test/typecheck/build command from
   package.json scripts, Cargo.toml, Makefile, or CI config. If undetectable,
   add it to the interview.
7. **Light interview:** Ask 2–5 clarifying questions — only ones that genuinely
   change the design (scope boundaries, behavioral ambiguities, integration
   choices). Prefer multiple-choice (AskUserQuestion). Do NOT re-ask anything the
   issue thread already settled — record those as Decisions with attribution
   instead. If nothing is ambiguous, say so and skip the interview.

## Phase: Design → GATE 1

Write `.work/<id>/design.md` following `templates/design.md`. Size to the
problem: ~40 lines for a small fix, ~150 for a large feature; every section earns
its place. The Implementation Design section must cite real `file:line` refs.
The Decisions section records every interview answer and every decision
extracted from the issue thread, attributed and dated, keeping sourced facts
separate from questions actually posed to the user. Open Questions must end
empty (resolved or explicitly deferred into Decisions).

**GATE 1 — stop here.** Tell the user the file path. They review and edit the
file directly, then tell you to continue (or re-run /cm-flow later). When
continuing, re-read design.md from disk before proceeding.

## Phase: Tracker → GATE 2

Split the approved design into `.work/<id>/tracker.md` following
`templates/tracker.md`:
- One task = one subagent-sized coherent change (typically 1–3 files) with its
  own acceptance criteria and a verifiable result.
- Number tasks `T<phase>.<n>`; record `deps:` between them.
- Every AC line should reference the Behavior invariant(s) it satisfies.
- Fill frontmatter: id, state, issue, branch, design, verify.

**GATE 2 — stop here.** User reviews/edits tracker.md, then approves. On
approval set frontmatter `state: implementing`.

## Phase: Implementation loop

Repeat until done:

1. Confirm `git branch --show-current` matches frontmatter `branch:` (check it
   out if not). Re-read tracker.md. Pick the first unchecked task whose deps are
   all checked.
   - Unchecked tasks remain but none runnable → report the blockage, stop.
   - No unchecked tasks → set `state: done`; print a summary (tasks completed,
     commits, Log deviations) and suggest the user open a PR (via the `cm-pr` skill). Never open one.
2. Assemble the implementer prompt from `prompts/implementer.md`: fill in the
   task fields and PASTE the relevant design.md excerpts (the task's phase
   section, the Behavior invariants its AC references, relevant Decisions).
   Content, not file paths — the subagent must not burn context re-discovering. Target files come from the design phase section.
3. Dispatch a general-purpose subagent with that prompt. On BLOCKED: append to
   Log, stop the loop, surface the reason to the user.
4. Dispatch a reviewer subagent from `prompts/reviewer.md` (task, AC, invariants,
   all of the task's commit hashes so far, the implementer's verify evidence). On
   re-review after a fix cycle the reviewer judges the cumulative diff of all the
   task's commits.
5. On PASS: check the task off (`- [x]`), append the commit hash(es) to the task
   line, add a Log entry; copy any deviations from the implementer's NOTES into the
   Log as deviation lines. On FAIL: re-dispatch the implementer with the findings
   appended under a `## Review findings to fix` section noting that prior commit(s)
   exist — fix on top with one new commit. Maximum 2 fix cycles;
   after that mark the task BLOCKED in the Log and stop for user input.
6. Keep tracker.md updated after every step — it is the single source of truth.

## Edge rules

- Verify command fails for reasons unrelated to the task's diff (pre-existing
  breakage): note it in the Log and judge the task on its own diff.
- An implementer reports a design assumption is wrong: stop the loop and surface
  it. The user amends design.md/tracker.md, then resumes. Never improvise around
  a broken design.
- Dirty working tree at intake or resume: stop and ask.
- No verify command and the user gave none: use the best available build/
  typecheck command and record it in frontmatter; if truly nothing exists,
  reviewer judges on the diff alone and the Log notes the gap — fill the
  reviewer packet's evidence slot with "none — no verify command (see Log)";
  the reviewer then skips check 4. In the implementer packet, drop
  Definition-of-done step 2 and have it report `VERIFY OUTPUT: none — no verify
  command`.
- Resuming mid-loop: before dispatching an implementer, check `git log` for a
  commit already referencing the task id; if found, skip straight to review of
  that task — run the verify command yourself and paste its output as the
  evidence block (the original implementer's report is gone).
