import { html } from "htm/preact";
import { formatTokenCount } from "../lib/format.js";

interface SessionHealthStripProps {
  contextPct: number;
  peakTokens: number;
  compactionCount: number;
}

function contextTone(pct: number): "green" | "amber" | "rose" {
  if (pct >= 70) return "rose";
  if (pct >= 60) return "amber";
  return "green";
}

function formatPeakLabel(tokens: number): string {
  if (tokens <= 0) return "0";
  return formatTokenCount(tokens) ?? String(tokens);
}

export function SessionHealthStrip({
  contextPct,
  peakTokens,
  compactionCount,
}: SessionHealthStripProps) {
  if (contextPct === 0 && peakTokens === 0 && compactionCount === 0) {
    return html`<span class="mono" style="color:var(--text3)">—</span>`;
  }

  const ctxFill = Math.max(0, Math.min(100, contextPct));
  const peakFill = Math.max(0, Math.min(100, peakTokens / 10_000));
  const tone = contextTone(contextPct);
  const peakLabel = formatPeakLabel(peakTokens);
  const ctxLabel = `${Math.round(contextPct)}%`;
  const tooltip = `Main session — context ${ctxLabel} · peak ${peakLabel} tokens · ${compactionCount} compaction${compactionCount === 1 ? "" : "s"}`;

  const squares = [0, 1, 2].map(
    (i) => html`<span class=${`hs-sq${i < compactionCount ? " hs-sq-on" : ""}`}></span>`,
  );

  return html`
    <div class="health-strip" title=${tooltip}>
      <div class=${`hs-bar hs-ctx hs-${tone}`}>
        <div class="hs-track"><div class="hs-fill" style=${`width:${ctxFill}%`}></div></div>
        <span class="hs-label">${ctxLabel}</span>
      </div>
      <div class="hs-bar hs-peak">
        <div class="hs-track"><div class="hs-fill" style=${`width:${peakFill}%`}></div></div>
        <span class="hs-label">${peakLabel}</span>
      </div>
      <div class="hs-comp">${squares}</div>
    </div>
  `;
}
