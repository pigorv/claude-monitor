# {Title} ({id}: {issue title}) <!-- free-text runs: omit the parenthetical -->

## Problem
{What & why, distilled from the issue body + maintainer/triage comments, with links
to the key comments. For free-text runs: the user's request, restated precisely.}

## Decisions
Each decision is binding for the design below. Separate what was *asked* from
what was *already settled* — never dress an extracted fact as a question.

### From the issue/thread (not asked — sourced)
- {decision} — source: {link to issue body / maintainer comment}, {YYYY-MM-DD}

### Clarified with the user (interview)        # omit this whole subsection if no interview happened
- **Q:** {question actually posed} → **A:** {user's answer} (user, {YYYY-MM-DD})

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
Must be empty before Gate 1 — every question either resolved into Decisions
or explicitly deferred there with a reason.
