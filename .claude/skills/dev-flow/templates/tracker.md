---
id: {id}
state: tracking            # tracking | implementing | done
issue: {issue URL, or "manual" for free-text runs}
branch: {feature branch name}
design: ./design.md
verify: {verify command, e.g. npm test && npm run typecheck}
---

# Tracker: {Title}

## Phase 1: {name}
- [ ] **T1.1** {task description} — deps: none
  - AC: {acceptance criteria; reference Behavior #N from design.md}
- [ ] **T1.2** {task description} — deps: T1.1
  - AC: {...}

## Phase 2: {name}
- [ ] **T2.1** {task description} — deps: T1.2
  - AC: {...}

## Log
Append-only. One line per event:
- {YYYY-MM-DD} {task id} done (commit {hash}, review: pass)
- {YYYY-MM-DD} {task id} review FAIL cycle {n}: {summary of findings}
- {YYYY-MM-DD} {task id} BLOCKED: {reason} — needs user input (task event; frontmatter state stays "implementing")
- {YYYY-MM-DD} deviation: {what changed vs design and why}
