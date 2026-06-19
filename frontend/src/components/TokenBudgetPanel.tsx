import { html } from "htm/preact";
import type { TokenBudget, TokenType } from "../../../src/shared/types";

// Compact token formatter for the legends — K/M form. Mirrors the per-component
// `formatTokens` helper in TokenBudgetSummary.tsx.
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(cost: number | null): string {
  return cost == null ? "—" : "$" + cost.toFixed(2);
}

// Stable, distinct color var per token type (vars defined in globals.css later).
function typeColor(t: TokenType): string {
  switch (t) {
    case "input":
      return "var(--color-token-input)";
    case "output":
      return "var(--color-token-output)";
    case "cache_read":
      return "var(--color-token-cache-read)";
    case "cache_write_5m":
      return "var(--color-token-cache-write-5m)";
    case "cache_write_1h":
      return "var(--color-token-cache-write-1h)";
  }
}

const TYPE_LABEL: Record<TokenType, string> = {
  input: "Input",
  output: "Output",
  cache_read: "Cache read",
  cache_write_5m: "Cache write 5m",
  cache_write_1h: "Cache write 1h",
};

const PARENT_COLOR = "var(--color-accent)";
const AGENTS_COLOR = "var(--color-status-completed)";

interface TokenBudgetPanelProps {
  budget: TokenBudget;
}

/**
 * Expanded token-budget panel (presentational only — no fetching / URL access).
 * Header shows billed tokens + estimated cost; two stacked bars break the spend
 * down by parent-vs-agents and by token type, each with a matching legend.
 */
export function TokenBudgetPanel({ budget }: TokenBudgetPanelProps) {
  const { parent, agents, by_type } = budget;

  const costHeader =
    budget.cost_total == null ? "—" : "$" + budget.cost_total.toFixed(2) + " est.";

  return html`
    <div class="token-budget-panel" id="token-budget-panel">
      <div class="tbp-header">
        <span class="tbp-header-tokens">
          <strong>${budget.billed_tokens.toLocaleString()}</strong> billed tokens
        </span>
        <span class="tbp-header-cost">${costHeader}</span>
      </div>

      <div class="tbp-section">
        <div class="tbp-section-label">PARENT VS AGENTS</div>
        <div class="tbp-bar">
          ${parent.tokens > 0 &&
          html`<div class="tbp-seg" style=${`flex:${parent.tokens};background:${PARENT_COLOR}`}></div>`}
          ${agents.tokens > 0 &&
          html`<div class="tbp-seg" style=${`flex:${agents.tokens};background:${AGENTS_COLOR}`}></div>`}
        </div>
        <div class="tbp-legend">
          <div class="tbp-legend-item">
            <span class="tbp-legend-dot" style=${`background:${PARENT_COLOR}`}></span>
            ${parent.pct}% parent · ${formatTokens(parent.tokens)} · ${formatCost(parent.cost)}
          </div>
          <div class="tbp-legend-item">
            <span class="tbp-legend-dot" style=${`background:${AGENTS_COLOR}`}></span>
            ${agents.pct}% agents · ${formatTokens(agents.tokens)} · ${formatCost(agents.cost)} · across ${agents.runs} run${agents.runs !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      <div class="tbp-section">
        <div class="tbp-section-label">BY TOKEN TYPE</div>
        <div class="tbp-bar">
          ${by_type
            .filter((entry) => entry.tokens > 0)
            .map(
              (entry) => html`
                <div
                  class="tbp-seg"
                  style=${`flex:${entry.tokens};background:${typeColor(entry.type)}`}
                ></div>
              `,
            )}
        </div>
        <div class="tbp-legend">
          ${by_type.map(
            (entry) => html`
              <div class="tbp-legend-item">
                <span class="tbp-legend-dot" style=${`background:${typeColor(entry.type)}`}></span>
                ${TYPE_LABEL[entry.type]} · ${formatTokens(entry.tokens)} · ${formatCost(entry.cost)}
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `;
}
