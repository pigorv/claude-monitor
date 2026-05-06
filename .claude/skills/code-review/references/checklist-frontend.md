# Preact + HTM frontend — specialist checklist

You are reviewing diff hunks under `frontend/src/**`. Apply the rubric in `severity-rubric.md`. Cite `file:line` for every finding. Cap output at 8 findings.

## Context

- Frontend: Preact + HTM tagged templates (no JSX transform). Components import `html` from `htm/preact`.
- Routing: hash-based (`#/sessions/:id?tab=timeline`). Allowlists like `VALID_TABS` gate user-supplied path segments.
- API client at `frontend/src/api/client.ts` uses `encodeURIComponent` on path params.
- Styles: plain CSS with custom properties, dark theme.
- No new dependencies without an explicit reason (CLAUDE.md: "Keep dependencies minimal").

## The HTM XSS hazard (read first)

HTM tagged templates do **not** auto-escape interpolated values when used in attribute or HTML positions. Anything from a transcript field is untrusted (project_name, session names, tool inputs, hook stdout/stderr, error strings, file paths). Render via Preact's text-content path (children of an element), not via raw HTML. The shape that's safe:

```js
html`<div class="title">${untrustedText}</div>`     // safe — text child
html`<a href=${untrustedUrl}>...</a>`               // attribute interpolation; check the attribute
```

The shape that's unsafe:

```js
html`<div>${rawHtmlString}</div>`                   // safe IF rawHtmlString is text, NOT if it's pre-rendered HTML
html`<div>${html([untrustedText])}</div>`           // taggedRaw — bypasses escape
html`<div dangerouslySetInnerHTML=${{__html: x}}/>` // explicit injection sink
```

Flag the unsafe shapes when a transcript-derived value reaches them.

## Rules

### CRITICAL — flag at confidence ≥ 4

| # | Rule | Bug shape |
|---|---|---|
| C1 | No `dangerouslySetInnerHTML` (or HTM equivalent) on a transcript-derived string. | Tool input preview rendered as raw HTML so a `<script>` in the transcript executes. |
| C2 | URL fragments and route params validated against an allowlist before being used in templates. | `tab=${url.searchParams.get('tab')}` interpolated into class names or attributes without `VALID_TABS` check. |
| C3 | API client paths use `encodeURIComponent` on path segments. | New endpoint adds a path param without encoding → `/api/sessions/${sessionId}` where `sessionId` could contain `/`. |

### HIGH — flag at confidence ≥ 6

| # | Rule | Bug shape |
|---|---|---|
| H1 | New dependency added — must be justified. | `package.json` adds a date library when `Intl.DateTimeFormat` would do. |
| H2 | Touched component has a corresponding test or snapshot. | `SessionDetail.tsx` rewrite with no update to its test. |
| H3 | Token-chart code respects the >= 2 data point requirement (uPlot crashes/blanks otherwise). | New chart component renders with no length check. |
| H4 | Dark-theme CSS variables used (no hardcoded `#fff` / `#000`). | New component using literal hex outside the project's variable set. |
| H5 | Hash routing changes update the route allowlist consistently. | New tab added to `SessionDetail` UI but `VALID_TABS` (or the route guard) not updated → fall-through. |
| H6 | Frontend types match server response shapes after a route changes. | Frontend reads `session.risk_score` but server now returns `riskScore`. |

### MEDIUM — flag at confidence ≥ 7

- M1: Preact key prop missing on a new list render → reorder bugs.
- M2: New `useEffect` without a cleanup for a subscription / interval / event listener.
- M3: New event handler arrow-defined inside JSX → unnecessary re-renders for memoized children. (Don't flag for cheap children.)
- M4: User-facing error string is the exception message, not an actionable hint (CLAUDE.md: actionable error messages).

### LOW — flag at confidence ≥ 8

- Inline styles where a CSS class would match the rest of the file.
- New file imports `htm` from a different path than the existing convention.
- Comment phrasing in a component describing *what* instead of *why*.

## Skip rules

In addition to the global skip rules in `severity-rubric.md`:

- Don't flag the absence of TypeScript prop types if the component is internal and small — the project doesn't enforce them.
- Don't flag accessibility issues unless the change adds a clearly inaccessible pattern (e.g., `<div onClick>` for a primary action). The repo doesn't claim WCAG conformance.
- Don't flag missing loading skeletons — the existing pattern is a plain "Loading…" string.
