import { html } from "htm/preact";
import type { TokenBudget } from "../../../src/shared/types";
import { resolveThresholds } from "../lib/chart-config";

// Compact token formatter — mirrors `formatTokens` in SessionDetail.tsx.
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Peak-severity ramp — replicates `peakAccentColor` in SessionDetail.tsx.
function peakAccentColor(pct: number): string {
  if (pct >= 80) return "var(--color-ctx-danger-text)";
  if (pct >= 40) return "var(--color-ctx-warn-text)";
  return "var(--color-ctx-safe-text)";
}

function formatCost(cost: number | null): string {
  return cost == null ? "—" : "$" + cost.toFixed(2);
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n));
}

interface TokenBudgetSummaryProps {
  budget: TokenBudget;
  model: string | null;
}

/**
 * Collapsed token-budget bar: a single rounded, bordered container split by a
 * thin vertical divider into a left cost half and a right context-peak half.
 * The chevron is a static (non-interactive) affordance — the expandable panel
 * is a separate story.
 */
export function TokenBudgetSummary({ budget, model }: TokenBudgetSummaryProps) {
  const thresholds = resolveThresholds(model);
  const dangerPct = clampPct(thresholds.dangerPct);
  const autoCompactPct = clampPct(thresholds.autoCompactPct);

  const peak = budget.context_peak;
  const accent = peakAccentColor(peak.pct);
  const fillPct = Math.min(peak.pct, 100);

  return html`
    <div class="token-budget-summary">
      <div class="tbs-cost">
        <span class="tbs-label">COST</span>
        <span class="tbs-cost-value">
          <span class="tbs-cost-amount">${formatCost(budget.cost_total)}</span>
          <span class="tbs-cost-tokens">${formatTokens(budget.billed_tokens)} tokens</span>
        </span>
        <svg
          class="tbs-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </div>
      <div class="tbs-divider"></div>
      <div class="tbs-context">
        <div class="tbs-context-head">
          <span class="tbs-label">CONTEXT PEAK</span>
          <span class="tbs-context-pct" style=${`color:${accent}`}>${Math.round(peak.pct)}%</span>
        </div>
        <div class="tbs-track">
          <div class="tbs-fill" style=${`width:${fillPct}%;background:${accent}`}></div>
          <div class="tbs-tick tbs-tick-danger" style=${`left:${dangerPct}%`}></div>
          <div class="tbs-tick tbs-tick-autocompact" style=${`left:${autoCompactPct}%`}></div>
        </div>
        <div class="tbs-context-tokens">${formatTokens(peak.peak_tokens)} / ${formatTokens(peak.max_tokens)}</div>
      </div>
    </div>
  `;
}
