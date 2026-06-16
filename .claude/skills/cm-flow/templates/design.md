# {Title} ({id}: {issue title}) <!-- free-text runs: omit the parenthetical -->

## Problem
{What & why, distilled from the issue body + maintainer/triage comments, with links
to the key comments. For free-text runs: the user's request, restated precisely.}

## Decisions (Q&A)
Clarifications gathered before design. Each answer is binding for the design below.
- **Q:** {question} → **A:** {answer} ({user | link to maintainer comment}, {YYYY-MM-DD})

## Behavior
Numbered, testable invariants — what must be true when this ships.
1. {invariant}
2. {invariant}

## Implementation Design
Grounded in real code — cite actual `file:line` references, not guesses.

### Phase 1: {name}
{What changes, which files, new types/functions, data flow.}

### Phase 2: {name}
{... repeat phase sections as the design needs; delete unused ones.}

## Validation
How each Behavior invariant is verified.
- Behavior #1 → {test or manual step}
- Behavior #2 → {...}

## Open Questions
Must be empty before Gate 1 — every question either resolved into Decisions (Q&A)
or explicitly deferred there with a reason.
