import type { TokenDataPoint } from "../../../src/shared/types";
import type uPlot from "uplot";

// ── Model threshold resolution ─────────────────────────────────────

interface ChartThresholds {
  maxTokens: number;
  warningPct: number;
  dangerPct: number;
  autoCompactPct: number;
}

const MODEL_THRESHOLDS: Record<string, ChartThresholds> = {
  opus:   { maxTokens: 200_000, autoCompactPct: 75.0,  warningPct: 60.0, dangerPct: 70.0 },
  sonnet: { maxTokens: 200_000, autoCompactPct: 83.5,  warningPct: 65.0, dangerPct: 75.0 },
  haiku:  { maxTokens: 200_000, autoCompactPct: 90.0,  warningPct: 70.0, dangerPct: 80.0 },
};

export function resolveThresholds(model: string | null | undefined): ChartThresholds {
  if (!model) return MODEL_THRESHOLDS.sonnet;
  const lower = model.toLowerCase();
  for (const key of Object.keys(MODEL_THRESHOLDS)) {
    if (lower.includes(key)) return MODEL_THRESHOLDS[key];
  }
  return MODEL_THRESHOLDS.sonnet;
}

// ── Data transformation ────────────────────────────────────────────

export interface ChartData {
  timestamps: number[];      // epoch seconds
  inputTokens: number[];
  outputTokens: number[];
  cacheReadTokens: number[];
  contextPct: number[];
  compactionIndices: number[];  // indices into timestamps where compaction occurred
  points: TokenDataPoint[];     // original data for tooltips
}

export function transformTimeline(timeline: TokenDataPoint[]): ChartData {
  const timestamps: number[] = [];
  const inputTokens: number[] = [];
  const outputTokens: number[] = [];
  const cacheReadTokens: number[] = [];
  const contextPct: number[] = [];
  const compactionIndices: number[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const p = timeline[i];
    timestamps.push(new Date(p.timestamp).getTime() / 1000);
    inputTokens.push(p.input_tokens);
    outputTokens.push(p.output_tokens);
    cacheReadTokens.push(p.cache_read_tokens);
    contextPct.push(p.context_pct);
    if (p.is_compaction) compactionIndices.push(i);
  }

  return { timestamps, inputTokens, outputTokens, cacheReadTokens, contextPct, compactionIndices, points: timeline };
}

// ── uPlot plugins ──────────────────────────────────────────────────

/** Draws horizontal threshold lines and shaded zones with pill labels */
export function thresholdPlugin(thresholds: ChartThresholds): uPlot.Plugin {
  const warningTokens = thresholds.maxTokens * (thresholds.warningPct / 100);
  const dangerTokens = thresholds.maxTokens * (thresholds.dangerPct / 100);
  const autoCompactTokens = thresholds.maxTokens * (thresholds.autoCompactPct / 100);

  function drawPillLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: string,
    bgColor: string,
  ) {
    ctx.font = "500 9px IBM Plex Mono, monospace";
    const tw = ctx.measureText(text).width;
    const px = 6, py = 2, h = 16, r = 4;
    const lx = x - tw - px * 2 - 4;
    const ly = y - h / 2;
    // Pill background
    ctx.fillStyle = bgColor;
    ctx.beginPath();
    ctx.roundRect(lx, ly, tw + px * 2, h, r);
    ctx.fill();
    // Pill text
    ctx.fillStyle = color;
    ctx.fillText(text, lx + px, ly + h - py - 2);
  }

  return {
    hooks: {
      draw: [
        (u: uPlot) => {
          const ctx = u.ctx;
          const { left, top, width, height } = u.bbox;

          const yScale = u.scales.y;
          if (yScale.min == null || yScale.max == null) return;

          const valToY = (val: number) => u.valToPos(val, "y", true);

          ctx.save();

          // Warning (degradation) zone
          if (warningTokens <= yScale.max! && warningTokens >= yScale.min!) {
            const warningY = valToY(warningTokens);
            const dangerY = dangerTokens <= yScale.max! ? valToY(dangerTokens) : valToY(yScale.max!);

            ctx.fillStyle = "rgba(161, 98, 7, 0.03)";
            ctx.fillRect(left, dangerY, width, warningY - dangerY);

            // Dashed line
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(161, 98, 7, 0.3)";
            ctx.beginPath();
            ctx.moveTo(left, warningY);
            ctx.lineTo(left + width, warningY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Pill label
            drawPillLabel(ctx, `degradation ${thresholds.warningPct}%`, left + width, warningY, "#a16207", "rgba(254, 252, 232, 0.9)");
          }

          // Danger / auto-compact zone
          if (autoCompactTokens <= yScale.max!) {
            const autoCompactY = valToY(autoCompactTokens);
            const dangerY = dangerTokens <= yScale.max! ? valToY(dangerTokens) : valToY(yScale.max!);

            ctx.fillStyle = "rgba(185, 28, 28, 0.04)";
            ctx.fillRect(left, autoCompactY, width, dangerY - autoCompactY);

            // Dashed line
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(185, 28, 28, 0.3)";
            ctx.beginPath();
            ctx.moveTo(left, autoCompactY);
            ctx.lineTo(left + width, autoCompactY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Pill label
            drawPillLabel(ctx, `auto-compact ${thresholds.autoCompactPct}%`, left + width, autoCompactY, "#b91c1c", "rgba(254, 242, 242, 0.9)");
          }

          ctx.restore();
        },
      ],
    },
  };
}

/** Draws vertical compaction markers with C1, C2, C3 pill labels */
export function compactionPlugin(chartData: ChartData): uPlot.Plugin {
  return {
    hooks: {
      draw: [
        (u: uPlot) => {
          const ctx = u.ctx;
          const { left, top, width, height } = u.bbox;

          ctx.save();

          for (let i = 0; i < chartData.compactionIndices.length; i++) {
            const idx = chartData.compactionIndices[i];
            const ts = chartData.timestamps[idx];
            const x = u.valToPos(ts, "x", true);

            // Vertical dashed line
            ctx.setLineDash([4, 3]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(194, 65, 12, 0.5)";
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + height + 8);
            ctx.stroke();

            // Pill label at top
            const label = `C${i + 1}`;
            ctx.setLineDash([]);
            ctx.font = "bold 9px IBM Plex Mono, monospace";
            const tw = ctx.measureText(label).width;
            const pillW = tw + 10;
            const pillH = 16;
            const lx = x - pillW / 2;
            const ly = top - 3;

            ctx.fillStyle = "#c2410c";
            ctx.beginPath();
            ctx.roundRect(lx, ly, pillW, pillH, 4);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.fillText(label, lx + 5, ly + 11.5);
          }

          ctx.restore();
        },
      ],
    },
  };
}

// ── Tooltip plugin ─────────────────────────────────────────────────

export function tooltipPlugin(chartData: ChartData): uPlot.Plugin {
  let tooltip: HTMLDivElement | null = null;

  function show(left: number, top: number, html: string) {
    if (!tooltip) return;
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }

  function hide() {
    if (tooltip) tooltip.style.display = "none";
  }

  return {
    hooks: {
      init: [
        (u: uPlot) => {
          tooltip = document.createElement("div");
          tooltip.className = "chart-tooltip";
          tooltip.style.display = "none";
          u.over.appendChild(tooltip);
        },
      ],
      setCursor: [
        (u: uPlot) => {
          const idx = u.cursor.idx;
          if (idx == null || idx < 0 || idx >= chartData.points.length) {
            hide();
            return;
          }

          const pt = chartData.points[idx];
          const cx = u.cursor.left!;
          const cy = u.cursor.top!;

          const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);

          let content = `<div class="tt-time">${new Date(pt.timestamp).toLocaleTimeString()}</div>`;
          content += `<div class="tt-row"><span class="tt-dot" style="background:#6d28d9"></span>Input: ${fmt(pt.input_tokens)}</div>`;
          content += `<div class="tt-row"><span class="tt-dot" style="background:#15803d"></span>Output: ${fmt(pt.output_tokens)}</div>`;
          content += `<div class="tt-row"><span class="tt-dot" style="background:#a78bfa"></span>Cache: ${fmt(pt.cache_read_tokens)}</div>`;
          content += `<div class="tt-row">Context: ${pt.context_pct.toFixed(1)}%</div>`;
          if (pt.is_compaction) {
            content += `<div class="tt-compaction">Compaction</div>`;
          }

          // Position tooltip to the right of cursor, flip if near edge
          const overWidth = u.over.getBoundingClientRect().width;
          const tooltipLeft = cx + 16 > overWidth - 160 ? cx - 176 : cx + 16;
          show(tooltipLeft, cy - 20, content);
        },
      ],
      setSelect: [hide],
    },
  };
}

// ── Build uPlot options ────────────────────────────────────────────

/** Gradient fill function for the input tokens series */
function inputGradientFill(u: uPlot, _seriesIdx: number): string | CanvasGradient {
  const { top, height } = u.bbox;
  // bbox isn't ready during legend init — return a flat color fallback
  if (!height || !isFinite(top) || !isFinite(height)) {
    return "rgba(109, 40, 217, 0.08)";
  }
  const grad = u.ctx.createLinearGradient(0, top, 0, top + height);
  grad.addColorStop(0, "rgba(109, 40, 217, 0.15)");
  grad.addColorStop(1, "rgba(109, 40, 217, 0.01)");
  return grad;
}

export function buildChartOpts(
  chartData: ChartData,
  thresholds: ChartThresholds,
  width: number,
  height: number
): uPlot.Options {
  return {
    width,
    height,
    cursor: {
      drag: { x: true, y: false, setScale: true },
    },
    scales: {
      x: { time: true },
      y: {
        auto: true,
        range: (_u, _min, max) => {
          // Always fit the data with headroom. Threshold lines/zones
          // will render if they fall within range, disappear if not.
          return [0, Math.max(max * 1.2, 1000)] as [number, number];
        },
      },
    },
    axes: [
      {
        stroke: "transparent",
        grid: { show: false },
        ticks: { show: false },
        font: "10px IBM Plex Mono, monospace",
        gap: 8,
        values: (_u: uPlot, vals: number[]) =>
          vals.map((v) => {
            const d = new Date(v * 1000);
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          }),
      },
      {
        stroke: "transparent",
        grid: { stroke: "rgba(232, 228, 223, 0.6)", width: 1 },
        ticks: { show: false },
        font: "10px IBM Plex Mono, monospace",
        size: 44,
        gap: 8,
        values: (_u: uPlot, vals: number[]) =>
          vals.map((v) => (v >= 1000 ? (v / 1000).toFixed(0) + "K" : String(v))),
      },
    ],
    series: [
      {}, // x-axis (timestamps)
      {
        label: "Input Tokens",
        stroke: "#6d28d9",
        width: 2,
        fill: inputGradientFill as any,
        points: { show: false },
      },
      {
        label: "Output Tokens",
        stroke: "#15803d",
        width: 1.5,
        points: { show: false },
      },
      {
        label: "Cache Read",
        stroke: "#6d28d9",
        width: 1,
        dash: [6, 4],
        alpha: 0.3,
        points: { show: false },
      },
    ],
    plugins: [
      thresholdPlugin(thresholds),
      compactionPlugin(chartData),
      tooltipPlugin(chartData),
    ],
  };
}
