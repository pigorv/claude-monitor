import type { TokenDataPoint, ContextThresholds, EventAnnotation } from "../../../src/shared/types";
import { MODEL_THRESHOLDS } from "../../../src/shared/model-thresholds";
import type uPlot from "uplot";

// ── Model threshold resolution ─────────────────────────────────────

/** Alias kept for backward-compat within chart code. */
export type ChartThresholds = ContextThresholds;

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
  timestamps: number[];        // epoch seconds
  effectiveContext: number[];   // raw tokens for tooltip display
  cacheReadTokens: number[];   // raw cache read tokens for tooltip
  contextPct: number[];        // Y-axis series: context utilization %
  cacheReadPct: number[];      // Y-axis series: cache read as % of max
  compactionIndices: number[]; // indices into timestamps where compaction occurred
  points: TokenDataPoint[];    // original data for tooltips
  annotations: EventAnnotation[];
}

export function transformTimeline(timeline: TokenDataPoint[], maxTokens: number, annotations?: EventAnnotation[]): ChartData {
  const timestamps: number[] = [];
  const effectiveContext: number[] = [];
  const cacheReadTokens: number[] = [];
  const contextPct: number[] = [];
  const cacheReadPct: number[] = [];
  const compactionIndices: number[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const p = timeline[i];
    timestamps.push(new Date(p.timestamp).getTime() / 1000);
    effectiveContext.push(p.input_tokens + p.cache_read_tokens + (p.cache_write_tokens ?? 0));
    cacheReadTokens.push(p.cache_read_tokens);
    contextPct.push(p.context_pct);
    cacheReadPct.push(maxTokens > 0 ? (p.cache_read_tokens / maxTokens) * 100 : 0);
    if (p.is_compaction) compactionIndices.push(i);
  }

  return {
    timestamps, effectiveContext, cacheReadTokens, contextPct, cacheReadPct,
    compactionIndices, points: timeline, annotations: annotations ?? [],
  };
}

// ── uPlot plugins ──────────────────────────────────────────────────

/** Draws horizontal threshold zone bands with dashed lines and % labels */
export function thresholdPlugin(thresholds: ChartThresholds): uPlot.Plugin {
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

          const warningPct = thresholds.warningPct;
          const dangerPct = thresholds.dangerPct;

          // Warning zone: warningPct → dangerPct
          if (warningPct <= yScale.max && warningPct >= yScale.min) {
            const warningY = valToY(warningPct);
            const dangerY = dangerPct <= yScale.max ? valToY(dangerPct) : valToY(yScale.max);

            ctx.fillStyle = "rgba(161, 98, 7, 0.06)";
            ctx.fillRect(left, dangerY, width, warningY - dangerY);

            // Dashed line at warning threshold
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(161, 98, 7, 0.25)";
            ctx.beginPath();
            ctx.moveTo(left, warningY);
            ctx.lineTo(left + width, warningY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Simple % label
            ctx.font = "500 10px IBM Plex Mono, monospace";
            ctx.textAlign = "end";
            ctx.fillStyle = "rgba(161, 98, 7, 0.5)";
            ctx.fillText(`${warningPct}%`, left + width - 4, warningY - 4);
          }

          // Danger zone: dangerPct → top of chart
          if (dangerPct <= yScale.max && dangerPct >= yScale.min) {
            const dangerY = valToY(dangerPct);

            ctx.fillStyle = "rgba(185, 28, 28, 0.04)";
            ctx.fillRect(left, top, width, dangerY - top);

            // Dashed line at danger threshold
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(185, 28, 28, 0.2)";
            ctx.beginPath();
            ctx.moveTo(left, dangerY);
            ctx.lineTo(left + width, dangerY);
            ctx.stroke();
            ctx.setLineDash([]);

            // Simple % label
            ctx.font = "500 10px IBM Plex Mono, monospace";
            ctx.textAlign = "end";
            ctx.fillStyle = "rgba(185, 28, 28, 0.45)";
            ctx.fillText(`${dangerPct}%`, left + width - 4, dangerY - 4);
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
          const { top, height } = u.bbox;

          ctx.save();

          for (let i = 0; i < chartData.compactionIndices.length; i++) {
            const idx = chartData.compactionIndices[i];
            const ts = chartData.timestamps[idx];
            const x = u.valToPos(ts, "x", true);

            // Vertical dashed line
            ctx.setLineDash([6, 3]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(185, 28, 28, 0.5)";
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

            ctx.fillStyle = "#b91c1c";
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

/** Draws event markers (file reads, agent events, compaction diamonds) on data points */
export function eventMarkerPlugin(chartData: ChartData): uPlot.Plugin {
  return {
    hooks: {
      draw: [
        (u: uPlot) => {
          const ctx = u.ctx;
          ctx.save();

          const dpr = devicePixelRatio;

          // Draw compaction diamonds first (from compactionIndices)
          for (const idx of chartData.compactionIndices) {
            const ts = chartData.timestamps[idx];
            const pct = chartData.contextPct[idx];
            const cx = u.valToPos(ts, "x", true);
            const cy = u.valToPos(pct, "y", true);
            const r = 6;

            ctx.beginPath();
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r - 1, cy);
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx - r + 1, cy);
            ctx.moveTo(cx, cy + r);
            ctx.lineTo(cx + r - 1, cy);
            ctx.moveTo(cx, cy + r);
            ctx.lineTo(cx - r + 1, cy);
            ctx.closePath();

            // Diamond shape
            ctx.beginPath();
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r - 1, cy);
            ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r + 1, cy);
            ctx.closePath();
            ctx.fillStyle = "#b91c1c";
            ctx.fill();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }

          // Draw annotation markers (skip if too many to avoid clutter)
          const annotations = chartData.annotations;
          const showMinor = annotations.length <= 30;

          for (const ann of annotations) {
            if (ann.index < 0 || ann.index >= chartData.timestamps.length) continue;

            // Skip bash/other_tool markers when there are many
            if (!showMinor && (ann.marker_type === 'bash' || ann.marker_type === 'other_tool')) continue;

            const ts = chartData.timestamps[ann.index];
            const pct = chartData.contextPct[ann.index];
            const cx = u.valToPos(ts, "x", true);
            const cy = u.valToPos(pct, "y", true);

            let fillColor: string;
            const r = 4;
            switch (ann.marker_type) {
              case 'file_read':
              case 'file_write':
                fillColor = "#6d28d9"; // purple
                break;
              case 'agent':
                fillColor = "#0e7490"; // teal
                break;
              case 'bash':
                fillColor = "#78716c"; // gray
                break;
              default:
                fillColor = "#a8a29e"; // light gray
                break;
            }

            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = fillColor;
            ctx.fill();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }

          ctx.restore();
        },
      ],
    },
  };
}

// ── Tooltip plugin ─────────────────────────────────────────────────

export function tooltipPlugin(chartData: ChartData, thresholds: ChartThresholds): uPlot.Plugin {
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

  // Build a lookup: index → annotations
  const annotationsByIndex = new Map<number, EventAnnotation[]>();
  for (const ann of chartData.annotations) {
    let list = annotationsByIndex.get(ann.index);
    if (!list) {
      list = [];
      annotationsByIndex.set(ann.index, list);
    }
    list.push(ann);
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

          const fmt = (n: number) => {
            if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
            if (n >= 1000) return (n / 1000).toFixed(1) + "K";
            return String(n);
          };

          // Zone color for %
          let pctColor = "#15803d"; // green
          if (pt.context_pct >= thresholds.dangerPct) pctColor = "#b91c1c"; // red
          else if (pt.context_pct >= thresholds.warningPct) pctColor = "#a16207"; // orange

          const effectiveCtx = pt.input_tokens + pt.cache_read_tokens + (pt.cache_write_tokens ?? 0);

          let content = `<div class="tt-time">${new Date(pt.timestamp).toLocaleTimeString()}</div>`;
          content += `<div class="tt-pct" style="color:${pctColor}">${pt.context_pct.toFixed(1)}%</div>`;
          content += `<div class="tt-row"><span class="tt-dot" style="background:#6d28d9"></span>${fmt(effectiveCtx)} of ${fmt(thresholds.maxTokens)} tokens</div>`;
          if (pt.cache_read_tokens > 0) {
            content += `<div class="tt-row"><span class="tt-dot" style="background:#0e7490"></span>Cache read: ${fmt(pt.cache_read_tokens)}</div>`;
          }

          if (pt.is_compaction) {
            content += `<div class="tt-compaction">Compaction</div>`;
          }

          // Event annotations — show single largest, collapse rest
          const anns = annotationsByIndex.get(idx);
          if (anns && anns.length > 0) {
            const typeColors: Record<string, string> = {
              file_read: "#6d28d9", file_write: "#6d28d9",
              agent: "#0e7490", bash: "#78716c", other_tool: "#a8a29e",
            };
            const typeLabels: Record<string, string> = {
              file_read: "Read", file_write: "Write",
              agent: "Agent", bash: "Bash", other_tool: "Tool",
            };

            // Sort by token_delta descending (largest impact first)
            const sorted = [...anns].sort((a, b) => {
              return (b.token_delta ?? 0) - (a.token_delta ?? 0);
            });

            const primary = sorted[0];
            // Truncate label from the left, keeping filename visible
            let label = primary.label;
            if (label.length > 32) label = "\u2026" + label.slice(-29);

            content += `<div class="tt-event-sep"></div>`;
            content += `<div class="tt-event">`;
            content += `<div class="tt-event-label" style="color:${typeColors[primary.marker_type] ?? '#6d28d9'}">${typeLabels[primary.marker_type] ?? primary.tool_name}: ${escapeHtml(label)}</div>`;
            if (primary.token_delta) {
              content += `<div class="tt-event-tokens">${primary.token_delta > 0 ? '+' : ''}${fmt(Math.abs(primary.token_delta))} tokens</div>`;
            }
            content += `</div>`;

            if (sorted.length > 1) {
              const rest = sorted.slice(1);
              const byType: Record<string, number> = {};
              for (const ev of rest) {
                const lbl = typeLabels[ev.marker_type] ?? ev.tool_name;
                byType[lbl] = (byType[lbl] || 0) + 1;
              }
              const summary = Object.entries(byType).map(([t, c]) => `${c} ${t}`).join(", ");
              content += `<div class="tt-event-more">+ ${rest.length} more (${summary})</div>`;
            }
          }

          // Position tooltip to the right of cursor, flip if near edge
          const overWidth = u.over.getBoundingClientRect().width;
          const tooltipLeft = cx + 16 > overWidth - 200 ? cx - 216 : cx + 16;
          show(tooltipLeft, cy - 20, content);
        },
      ],
      setSelect: [hide],
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Auto-scaling Y-axis ─────────────────────────────────────────────

export interface YScale {
  maxY: number;
  tickStep: number;
  warningVisible: boolean;
  dangerVisible: boolean;
}

export function computeYScale(contextPct: number[], thresholds: ChartThresholds): YScale {
  const peakPct = contextPct.length > 0 ? Math.max(...contextPct) : 0;
  const niceSteps = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
  const target = peakPct * 1.3;
  let maxY = 100;
  for (const step of niceSteps) {
    const candidate = Math.ceil(target / step) * step;
    if (candidate >= target && candidate >= peakPct + 2) {
      maxY = candidate;
      break;
    }
  }
  maxY = Math.min(maxY, 100);
  // Ensure at least 5
  if (maxY < 5) maxY = 5;

  let tickStep: number;
  if (maxY <= 10) tickStep = 2;
  else if (maxY <= 20) tickStep = 5;
  else if (maxY <= 50) tickStep = 10;
  else tickStep = 20;

  return {
    maxY,
    tickStep,
    warningVisible: thresholds.warningPct <= maxY,
    dangerVisible: thresholds.dangerPct <= maxY,
  };
}

// ── Crosshair plugin ────────────────────────────────────────────────

/** Draws a vertical crosshair line at cursor position */
export function crosshairPlugin(): uPlot.Plugin {
  let crosshairEl: HTMLDivElement | null = null;

  return {
    hooks: {
      init: [
        (u: uPlot) => {
          crosshairEl = document.createElement("div");
          crosshairEl.className = "chart-crosshair";
          crosshairEl.style.display = "none";
          u.over.appendChild(crosshairEl);
        },
      ],
      setCursor: [
        (u: uPlot) => {
          if (!crosshairEl) return;
          const left = u.cursor.left!;
          if (left < 0 || u.cursor.idx == null) {
            crosshairEl.style.display = "none";
            return;
          }
          crosshairEl.style.display = "block";
          crosshairEl.style.left = left + "px";
          crosshairEl.style.height = u.over.clientHeight + "px";
        },
      ],
    },
  };
}

// ── Build uPlot options ────────────────────────────────────────────

/** Gradient fill function for the context % series */
function contextGradientFill(u: uPlot, _seriesIdx: number): string | CanvasGradient {
  const { top, height } = u.bbox;
  if (!height || !isFinite(top) || !isFinite(height)) {
    return "rgba(109, 40, 217, 0.08)";
  }
  const grad = u.ctx.createLinearGradient(0, top, 0, top + height);
  grad.addColorStop(0, "rgba(109, 40, 217, 0.18)");
  grad.addColorStop(1, "rgba(109, 40, 217, 0.02)");
  return grad;
}

export function buildChartOpts(
  chartData: ChartData,
  thresholds: ChartThresholds,
  width: number,
  height: number
): uPlot.Options {
  const yScale = computeYScale(chartData.contextPct, thresholds);

  return {
    width,
    height,
    cursor: {
      drag: { x: true, y: false, setScale: true },
      points: {
        size: (_u: uPlot, _seriesIdx: number) => 5 * devicePixelRatio,
        width: 0,
        stroke: "transparent",
        fill: (_u: uPlot, seriesIdx: number) => {
          const fills = ["", "#6d28d9", "rgba(14,116,144,0.6)"];
          return fills[seriesIdx] || "#888";
        },
      },
    },
    scales: {
      x: { time: true },
      y: {
        auto: false,
        range: [0, yScale.maxY] as uPlot.Range.MinMax,
      },
    },
    axes: [
      {
        stroke: "#a8a29e",
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
        stroke: "#a8a29e",
        grid: { stroke: "rgba(232, 228, 223, 0.6)", width: 1 },
        ticks: { show: false },
        font: "10px IBM Plex Mono, monospace",
        size: 36,
        gap: 8,
        incrs: [1, 2, 5, 10, 20, 25, 50, 100].filter(v => v >= yScale.tickStep),
        values: (_u: uPlot, vals: number[]) =>
          vals.map((v) => v + "%"),
      },
    ],
    series: [
      {}, // x-axis (timestamps)
      {
        label: "Context %",
        stroke: "#6d28d9",
        width: 2,
        fill: contextGradientFill as any,
        points: { show: false },
      },
      {
        label: "Cache Read",
        stroke: "rgba(14, 116, 144, 0.4)",
        width: 1,
        fill: "rgba(14, 116, 144, 0.08)",
        points: { show: false },
      },
    ],
    plugins: [
      thresholdPlugin(thresholds),
      compactionPlugin(chartData),
      eventMarkerPlugin(chartData),
      crosshairPlugin(),
      tooltipPlugin(chartData, thresholds),
    ],
  };
}
