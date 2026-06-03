# Design-System Reference — claude-monitor

> Steward's working memory. Source of truth for the token contracts.
> Exact hex values live in `frontend/src/styles/globals.css` `:root`. Never restate hex here.

---

## 1. Semantic Ramp Ownership

**Rule: one ramp = one meaning; no ramp crosses territory.**

| Ramp | Owns |
|------|------|
| **Purple** | Active tab · selected pill / dropdown option · model tag · slash-command pill · skill badge · Edit / modify / agentic tools · running agent bar · running status · user-message pill |
| **Teal** | Completed badge · live session dot · done agent bar · subagent pills & blocks · session-start pill · ctx-safe |
| **Amber** | ctx-warning (40–65) · compaction · insight / trigger-auto banners · Bash tool · thinking body |
| **Red** | ctx-danger (65+) · errors · rejected / failed |
| **Gray** | Idle text · borders · metadata · muted surfaces · default / unknown tool · session-end pill · assistant-message pill |
| **Blue** *(tool palette)* | Read + search tools (Grep, Glob, Web*, ToolSearch) · linked-session reference accent |
| **Green** *(tool palette)* | Write / creation tools · added-diff |

---

## 2. Semantic Token Groups

All tokens are Tier-2 `--color-*` names defined in `frontend/src/styles/globals.css`.

### Text
`--color-text-primary` / `--color-text-secondary` / `--color-text-tertiary` / `--color-text-inverse`

### Background
`--color-background-primary` / `--color-background-secondary` / `--color-background-tertiary` / `--color-background-hover` / `--color-background-active`

### Border
`--color-border-primary` / `--color-border-secondary` / `--color-border-accent`

### Accent (links, focus, generic interactive)
`--color-accent` / `--color-accent-tint`

### Interactive selection (Purple ramp)
`--color-interactive-selected-bg` / `--color-interactive-selected-border` / `--color-interactive-selected-text` / `--color-interactive-tab-active-line` / `--color-interactive-count-bg-selected`

### Status
`--color-status-completed` / `--color-status-completed-bg` / `--color-status-completed-text` — Teal: completed badge / live session dot
`--color-status-running` — Purple: in-progress
`--color-status-warning-bg` / `--color-status-warning-text` — Amber: warnings
`--color-status-danger-bg` / `--color-status-danger-text` — Red: errors / failures

### Tool tags (five CSS classes, each pair of tokens)
`--color-tool-bash-bg` / `--color-tool-bash-text` — Amber
`--color-tool-read-bg` / `--color-tool-read-text` — Blue
`--color-tool-edit-bg` / `--color-tool-edit-text` — Purple
`--color-tool-write-bg` / `--color-tool-write-text` — Green
`--color-tool-default-bg` / `--color-tool-default-text` — Gray

### Agent Gantt bars
`--color-agent-bar-active` — Purple (running)
`--color-agent-bar-done` — Teal (completed)
Failed bar reuses `--color-status-danger-text`.

### Context graduated readout
`--color-ctx-safe-bg` / `--color-ctx-safe-text` — Teal
`--color-ctx-warn-bg` / `--color-ctx-warn-text` — Amber
`--color-ctx-danger-bg` / `--color-ctx-danger-text` — Red

---

## 3. Helpers

### Tool tags → `toolTagClass(name)`

Defined in `frontend/src/lib/tool-tags.ts`. Returns exactly one of five CSS classes. Match order is **load-bearing** (first hit wins):

| Order | Matches (case-insensitive) | Returns | Ramp |
|-------|---------------------------|---------|------|
| 1 | contains `bash` | `tool-bash` | Amber |
| 2 | matches `edit\|multiedit\|notebook\|task\|agent\|todo\|ask` | `tool-edit` | Purple |
| 3 | contains `write` | `tool-write` | Green |
| 4 | matches `read\|grep\|glob\|web\|search\|fetch` | `tool-read` | Blue |
| 5 | anything else | `tool-default` | Gray |

**Key consequence of order:** `TodoWrite` hits rule 2 (`todo`) → `tool-edit` (Purple). The file tool `Write` hits rule 3 → `tool-write` (Green). `Edit` / `MultiEdit` / `NotebookEdit` → `tool-edit`.

### Context bands → `ctxLevel(pct)`

Defined in `frontend/src/lib/ctx.ts`. Returns `'safe' | 'warn' | 'danger'`:
- `safe` — pct < 40
- `warn` — 40 ≤ pct ≤ 65
- `danger` — pct > 65

### Chart / canvas colors → `CHART` in `chart-palette.ts`

Defined in `frontend/src/lib/chart-palette.ts`. The **only** place raw hex is allowed outside `globals.css` Tier-1 primitives — because `<canvas>` cannot read `var()`. Values mirror the semantic ramps. Never duplicate these constants elsewhere.

---

## 4. Event-Pill Mapping

From `TYPE_PILL_CLASS` in `frontend/src/components/EventCard.tsx`:

| Event type | Pill class | Ramp |
|------------|-----------|------|
| `user_message` | `pill-purple` | Purple |
| `assistant_message` | `pill-gray` | Gray |
| `session_end` | `pill-gray` | Gray |
| `notification` | `pill-gray` | Gray |
| `thinking` | `pill-amber` | Amber |
| `compaction` | `pill-amber` | Amber |
| `subagent_start` / `subagent_end` | `pill-teal` | Teal |
| `session_start` | `pill-teal` | Teal |
| `tool_call_start` / `tool_call_end` | `pill-tool` | per `toolTagClass()` |

---

## 5. Do / Don't

**DO**
```css
/* Use a Tier-2 semantic token */
.my-badge { color: var(--color-status-danger-text); }
.my-badge { background: var(--color-status-warning-bg); }
```
```ts
// Use helpers for tool tags, context bands, and charts
const cls = toolTagClass(event.tool_name);      // → "tool-bash" etc.
const band = ctxLevel(pct);                     // → "safe" | "warn" | "danger"
const color = CHART.ctxDanger;                  // canvas only
```

**DON'T**
```css
/* Raw hex — NEVER in a component */
.my-badge { color: #A32D2D; }

/* Tier-1 primitive ref — NEVER in a component */
.my-badge { color: var(--red-600); }

/* Legacy token — NEVER after migration */
.my-badge { color: var(--danger); }
```
```ts
// Never hardcode color in a component outside chart-palette.ts
style={{ color: '#A32D2D' }}
```

---

## 6. Hard Rules

1. **No raw hex / rgba in components.** The only allowed location for raw hex outside `globals.css` Tier-1 primitives is `frontend/src/lib/chart-palette.ts`.
2. **Never reference a Tier-1 primitive directly in a component.** Always go through a Tier-2 `--color-*` semantic token.
3. **One ramp = one meaning.** Never repurpose a ramp for a different semantic (e.g., do not use Purple for warnings).
4. **Tool tags only via `toolTagClass()`.** Never hand-roll a tool-to-class mapping in a component.
5. **Context bands only via `ctxLevel()`.** Never inline the 40/65 thresholds.
6. **Chart / canvas colors only via `chart-palette.ts`.** Never duplicate hex constants in another file.
7. **Any new semantic token must record its dark value** (comment `/* dark → ... */` adjacent to the declaration). This keeps the system dark-ready.
8. **The guard is `npm run lint:tokens`.** It must stay clean after every UI change. Run it before committing any `.css` or `.tsx` file.
