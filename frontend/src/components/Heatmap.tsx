import { html } from "htm/preact";
import type { TokenDataPoint } from "../../../src/shared/types";

interface HeatmapProps {
  timeline: TokenDataPoint[];
}

const MAX_CELLS = 50;

function downsample(timeline: TokenDataPoint[], maxCells: number): number[] {
  if (timeline.length === 0) return [];
  if (timeline.length <= maxCells) return timeline.map((p) => p.context_pct);

  const result: number[] = [];
  const step = timeline.length / maxCells;
  for (let i = 0; i < maxCells; i++) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < timeline.length; j++) {
      sum += timeline[j].context_pct;
      count++;
    }
    result.push(count > 0 ? sum / count : 0);
  }
  return result;
}

export function cellColor(pct: number): string {
  if (pct < 20) return "rgba(21, 128, 61, 0.15)";
  if (pct < 40) return "rgba(21, 128, 61, 0.35)";
  if (pct < 55) return "rgba(161, 98, 7, 0.25)";
  if (pct < 70) return "rgba(194, 65, 12, 0.35)";
  if (pct < 80) return "rgba(194, 65, 12, 0.55)";
  return "rgba(185, 28, 28, 0.6)";
}

export const HEATMAP_LEGEND_STEPS = [10, 30, 47, 62, 75, 85];

export function Heatmap({ timeline }: HeatmapProps) {
  const cells = downsample(timeline, MAX_CELLS);

  if (cells.length === 0) return null;

  return html`
    <div class="heatmap-strip">
      <div class="heatmap-bar">
        ${cells.map(
          (pct, i) => html`
            <div
              key=${i}
              class="heatmap-cell"
              style=${{ backgroundColor: cellColor(pct) }}
              title=${`${pct.toFixed(1)}% context`}
            />
          `
        )}
      </div>
      <div class="heatmap-labels">
        <span>Session start</span>
        <span>Session end</span>
      </div>
    </div>
  `;
}
