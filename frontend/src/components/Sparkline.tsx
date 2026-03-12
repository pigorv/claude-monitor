import { html } from "htm/preact";

interface MiniTimelinePoint {
  context_pct: number;
  is_compaction: boolean;
}

interface SparklineProps {
  data: MiniTimelinePoint[];
  width?: number;
  height?: number;
}

export function Sparkline({ data, width = 56, height = 20 }: SparklineProps) {
  if (!data || data.length === 0) {
    return html`<span class="mono" style="color:var(--text3)">—</span>`;
  }

  const padding = 1;
  const maxPct = Math.max(...data.map((d) => d.context_pct), 1);
  const xStep = (width - padding * 2) / Math.max(data.length - 1, 1);

  const points = data
    .map((d, i) => {
      const x = padding + i * xStep;
      const y = height - padding - ((d.context_pct / maxPct) * (height - padding * 2));
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Color by peak value
  const peak = Math.max(...data.map((d) => d.context_pct));
  let stroke = "var(--green)";
  if (peak >= 60) stroke = "var(--red)";
  else if (peak >= 30) stroke = "var(--yellow)";

  return html`
    <svg class="spark" viewBox="0 0 ${width} ${height}">
      <polyline
        points=${points}
        fill="none"
        stroke=${stroke}
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    </svg>
  `;
}
