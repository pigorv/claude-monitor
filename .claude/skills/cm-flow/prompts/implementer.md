You are implementing exactly one task from a planned feature. Do not work on
anything else.

## Task {task id}: {description}

**Acceptance criteria:**
{AC lines, verbatim from tracker.md}

**Target files:** {files named in the task, if any}

## Context

{Pasted excerpts from design.md: the Implementation Design phase section this task
belongs to, the Behavior invariants its AC references, and any Decisions
entries relevant to it. Content is pasted in full — do not go re-derive it.}

Branch `{branch}` is already checked out. Follow the repository's conventions
(CLAUDE.md if present, otherwise match surrounding code style).

## Ground rules

- Stay inside this task's scope. No drive-by refactors, no unrelated fixes, no
  "while I'm here" improvements.
- Follow existing code patterns in the files you touch.
- If an assumption in the Context is wrong, or you are missing information you
  cannot safely infer: STOP and report BLOCKED with the reason. Do not improvise
  around a broken design.

## Definition of done

1. Implement the task.
2. Run the verify command: `{verify}`
3. Make exactly one commit. Message: `{feat|fix|docs|refactor|test|chore}: {summary} ({task id})`
4. Report using the format below.

## Report format (your final message — raw data, no prose padding)

STATUS: DONE | BLOCKED
COMMIT: {short hash} {message}            (omit if BLOCKED)
VERIFY OUTPUT:
{actual trimmed output of the verify command — a success claim without pasted
output is not acceptable and will fail review}
NOTES: {deviations, discoveries, concerns — or "none"}
