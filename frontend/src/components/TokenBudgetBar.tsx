import { html } from "htm/preact";

interface TokenBudgetBarProps {
  parentTokens: number;
  agents: Array<{
    agentId: string;
    description: string;
    tokens: number;
  }>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function TokenBudgetBar({ parentTokens, agents }: TokenBudgetBarProps) {
  const agentTotal = agents.reduce((sum, a) => sum + a.tokens, 0);
  const total = parentTokens + agentTotal;
  if (total <= 0) return null;

  const parentPct = Math.round((parentTokens / total) * 100);
  const agentPct = 100 - parentPct;
  const agentCount = agents.length;

  return html`
    <div class="token-budget">
      <div class="token-budget-header">
        <span class="token-budget-title">Token budget</span>
        <span class="token-budget-total"><strong>${formatTokens(total)}</strong> total tokens</span>
      </div>
      <div class="token-bar">
        <div
          class="token-seg"
          style=${"flex:" + parentTokens + ";background:var(--accent)"}
          title=${"Parent session: " + formatTokens(parentTokens) + " tokens (" + parentPct + "%)"}
        >Parent ${formatTokens(parentTokens)}</div>
        ${agentTotal > 0 && html`
          <div
            class="token-seg"
            style=${"flex:" + agentTotal + ";background:#3d6b80"}
            title=${"Agents: " + formatTokens(agentTotal) + " tokens across " + agentCount + " sub-agents (" + agentPct + "%)"}
          >Agents ${formatTokens(agentTotal)}${agentCount > 0 ? ` (${agentCount})` : ""}</div>
        `}
      </div>
      <div class="token-legend">
        <div class="token-legend-item">
          <span class="token-legend-dot" style="background:var(--accent)"></span>
          ${parentPct}% parent session
        </div>
        ${agentTotal > 0 && html`
          <div class="token-legend-item" style="margin-left:auto">
            <span class="token-legend-dot" style="background:#3d6b80"></span>
            ${agentPct}% across ${agentCount} sub-agent${agentCount !== 1 ? "s" : ""}
          </div>
        `}
      </div>
    </div>
  `;
}
