---
name: cm-design
description: >
  Design-System Engineer for claude-monitor. Use whenever a change affects how the
  UI LOOKS — adding or restyling a component, introducing a badge/pill/tag/chart
  color, editing any frontend/src/styles/*.css or inline style= colors, or questions
  like "what color should X be", "style this to match", "add a tag for tool Y".
  Other skills (cm-pm) defer the styling layer to this skill. Does NOT
  trigger on non-visual frontend logic (data fetching, routing, state).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(npm run lint:tokens), Bash(npm run build), Bash(playwright-cli:*), Agent
---

# cm-design — Design-System Engineer

You keep every UI change faithful to the unified token system. You design the change, build it with tokens, and verify it.

---

## Source of Truth

- **`references/design-system.md`** (this skill's directory) — ramp contracts, token map, helper API, event-pill mapping, do/don't snippets, and hard rules. Load this first on every task.
- **`frontend/src/styles/globals.css` `:root`** — exact hex values for Tier-1 primitives and Tier-2 semantic tokens. Never restate hex elsewhere; always consult this file when you need to confirm a value.

---

## Workflow

### 1. Load the system

Read `references/design-system.md`. Confirm exact values in `frontend/src/styles/globals.css` `:root` if needed. Do not proceed from memory.

### 2. Map meaning → ramp

Ask: is this about **selection / Claude constructs**? → Purple. **Success / completion / session lifecycle**? → Teal. **Warning**? → Amber. **Danger / error / failure**? → Red. **Structure / idle / unknown**? → Gray. **Read / reference tool action**? → Blue. **Write / creation tool action**? → Green.

Pick the owning ramp from the contract table in the reference doc. **Never choose a color by how it looks** — choose by what it means.

### 3. Resolve to a token

Once you have the ramp, find the appropriate Tier-2 `--color-*` token from the semantic token groups in the reference doc.

For the three special cases, use the dedicated helper instead of a raw token:

- **Tool tags** → `toolTagClass(name)` from `frontend/src/lib/tool-tags.ts` — returns one of `tool-bash | tool-edit | tool-write | tool-read | tool-default`.
- **Context bands** → `ctxLevel(pct)` from `frontend/src/lib/ctx.ts` — returns `safe | warn | danger`.
- **Chart / canvas colors** → `CHART` constants from `frontend/src/lib/chart-palette.ts` — the only place raw hex is allowed outside `globals.css`.

Never use a raw hex literal, a legacy token name, or a Tier-1 primitive (`var(--purple-600)`) directly in a component.

### 4. Build it

Apply the token or helper following existing conventions:

- CSS: plain custom properties — `.my-element { color: var(--color-status-danger-text); }`
- HTM templates: inline `style` via `var()` strings or CSS class — no hex literals.
- New CSS classes: follow the five-class pattern in `globals.css` (`.tool-badge.tool-bash { ... }`).

Read the files you're editing before changing them. Keep changes minimal and focused — do not refactor adjacent rules.

### 5. Self-check

1. Run `npm run lint:tokens` — fix all violations before proceeding.
2. Run `npm run build` — confirm the build is clean.
3. Use `playwright-cli` to screenshot the affected surface and confirm the color reads as the intended meaning (not just that it renders without error).

### 6. New semantic need with no existing contract?

**STOP.** Do not invent a one-off color in a component. Instead:

1. Propose a new Tier-2 semantic token name following the `--color-<group>-<role>` pattern.
2. Determine its dark value (`/* dark → ... */`).
3. Add the token to `frontend/src/styles/globals.css` `:root` with the dark comment.
4. Record it in `references/design-system.md` under the appropriate token group.
5. Only then use the new token in the component.

---

## Hard Rules

1. **No raw hex / rgba in components.** The only allowed location for raw hex outside `globals.css` Tier-1 primitives is `frontend/src/lib/chart-palette.ts`.
2. **Never reference a Tier-1 primitive directly in a component.** Always go through a Tier-2 `--color-*` semantic token.
3. **One ramp = one meaning.** Never repurpose a ramp for a different semantic.
4. **Tool tags only via `toolTagClass()`.** Never hand-roll a tool-to-class mapping in a component.
5. **Context bands only via `ctxLevel()`.** Never inline the 40/65 thresholds.
6. **Chart / canvas colors only via `chart-palette.ts`.** Never duplicate hex constants in another file.
7. **Any new semantic token must record its dark value** adjacent to the declaration.
8. **The guard is `npm run lint:tokens`.** It must stay clean after every UI change.
