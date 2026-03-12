import { useRef, useEffect, useState, useCallback } from "preact/hooks";
import { html } from "htm/preact";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { TokenDataPoint, CompactionDetail } from "../../../src/shared/types";
import {
  resolveThresholds,
  transformTimeline,
  buildChartOpts,
} from "../lib/chart-config";
import { Heatmap } from "./Heatmap";

interface TokenChartProps {
  timeline: TokenDataPoint[];
  model: string | null | undefined;
  compactionDetails?: CompactionDetail[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

export function TokenChart({ timeline, model, compactionDetails }: TokenChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 220 });

  const thresholds = resolveThresholds(model);
  const chartData = transformTimeline(timeline);

  // Resize observer on the outer wrapper
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) {
        // Subtract padding (20px * 2)
        setDimensions({ width: rect.width - 40, height: 220 });
      }
    };

    updateSize();

    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Create/update chart
  useEffect(() => {
    const el = canvasRef.current;
    if (!el || timeline.length === 0) return;

    // Destroy previous chart
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

    const opts = buildChartOpts(chartData, thresholds, dimensions.width, dimensions.height);
    const data: uPlot.AlignedData = [
      chartData.timestamps,
      chartData.inputTokens,
      chartData.outputTokens,
      chartData.cacheReadTokens,
    ];

    chartRef.current = new uPlot(opts, data, el);

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [timeline, dimensions.width, dimensions.height, model]);

  // Reset zoom handler
  const handleResetZoom = useCallback(() => {
    if (chartRef.current && chartData.timestamps.length > 0) {
      chartRef.current.setScale("x", {
        min: chartData.timestamps[0],
        max: chartData.timestamps[chartData.timestamps.length - 1],
      });
    }
  }, [chartData.timestamps]);

  if (timeline.length === 0) {
    return html`<div class="status-text">No token data available for this session.</div>`;
  }

  // Compaction events for the table below
  const compactionEvents = timeline.filter((p) => p.is_compaction);

  // Context stats
  const peakUtilization = Math.max(...timeline.map((p) => p.context_pct));
  const totalTokens = timeline.reduce((s, p) => s + p.input_tokens + p.output_tokens, 0);
  const totalCache = timeline.reduce((s, p) => s + p.cache_read_tokens, 0);
  const cacheHitRate = totalTokens > 0 ? (totalCache / (totalTokens + totalCache)) * 100 : 0;
  const contextResets = compactionEvents.length;

  // Peak utilization timestamp and pre-compaction label
  const peakEntry = timeline.reduce((best, p) => p.context_pct > best.context_pct ? p : best, timeline[0]);
  const peakTimestamp = new Date(peakEntry.timestamp).toLocaleTimeString("en-US", { hour12: false });
  const compactionTimestamps = compactionEvents.map(e => new Date(e.timestamp).getTime());
  const peakTime = new Date(peakEntry.timestamp).getTime();
  const preCIdx = compactionTimestamps.findIndex(t => t > peakTime);
  const preCLabel = preCIdx >= 0 ? ` pre-C${preCIdx + 1}` : "";

  // Average token loss across compaction details
  const avgTokenLoss = compactionDetails && compactionDetails.length > 0
    ? compactionDetails.reduce((sum, cd) => sum + (cd.tokens_before - cd.tokens_after), 0) / compactionDetails.length
    : 0;

  const modelName = model ? (model.toLowerCase().includes("opus") ? "Opus" : model.toLowerCase().includes("sonnet") ? "Sonnet" : model.toLowerCase().includes("haiku") ? "Haiku" : model) : "unknown";

  return html`
    <div class="context-tab">
      <div class="section-title">Context utilization over time</div>
      <${Heatmap} timeline=${timeline} />

      <div class="chart-container" ref=${wrapperRef}>
        <div class="chart-header">
          <div class="chart-legend">
            <span class="legend-item"><span class="legend-dot" style="background:#6d28d9"></span> Input tokens</span>
            <span class="legend-item"><span class="legend-dot" style="background:#15803d"></span> Output tokens</span>
            <span class="legend-item"><span class="legend-dot legend-dot-faded" style="background:#6d28d9"></span> Cache read</span>
            <span class="legend-sep">|</span>
            <span class="legend-item"><span class="legend-dot legend-dot-line" style="background:#c2410c"></span> Compaction</span>
          </div>
          <div class="chart-model-label">${formatTokens(thresholds.maxTokens)} context window (${modelName})</div>
        </div>
        <div class="chart-canvas-wrap" ref=${canvasRef}></div>
      </div>

      <div class="context-stats-row">
        <div class="stat-card">
          <div class="label">Peak utilization</div>
          <div class="value ${peakUtilization >= 70 ? "text-danger" : peakUtilization >= 50 ? "text-warning" : ""}">${peakUtilization.toFixed(1)}%</div>
          <div class="detail">at ${peakTimestamp}${preCLabel}</div>
        </div>
        <div class="stat-card">
          <div class="label">Tokens processed</div>
          <div class="value">${formatTokens(totalTokens)}</div>
          <div class="detail">input + output combined</div>
        </div>
        <div class="stat-card">
          <div class="label">Cache hit rate</div>
          <div class="value" style="color: ${cacheHitRate >= 50 ? 'var(--green)' : ''}">${cacheHitRate.toFixed(1)}%</div>
          <div class="detail">avg across session</div>
        </div>
        <div class="stat-card">
          <div class="label">Context resets</div>
          <div class="value" style="color: ${contextResets > 0 ? 'var(--orange)' : ''}">${contextResets}</div>
          ${avgTokenLoss > 0 && html`<div class="detail">avg loss ${formatTokens(avgTokenLoss)} each</div>`}
        </div>
      </div>

      ${(compactionDetails && compactionDetails.length > 0) ? html`
        <div class="compaction-table-section">
          <div class="section-title">Compaction events</div>
          <div class="card">
          <table class="compact-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Trigger</th>
                <th>Before</th>
                <th>After</th>
                <th>Lost</th>
                <th>Context</th>
                <th>Likely dropped</th>
              </tr>
            </thead>
            <tbody>
              ${compactionDetails.map((cd, i) => {
                const time = new Date(cd.timestamp).toLocaleTimeString();
                const lost = cd.tokens_before - cd.tokens_after;
                const contextPct = (cd.tokens_after / thresholds.maxTokens) * 100;
                const barColor = contextPct >= 70 ? "var(--orange)" : contextPct >= 50 ? "var(--yellow)" : "var(--green)";
                return html`
                  <tr key=${i}>
                    <td class="mono">${time}</td>
                    <td><span class="trigger-badge ${cd.trigger === "auto" ? "auto" : "manual"}">${cd.trigger}</span></td>
                    <td class="mono">${formatTokens(cd.tokens_before)}</td>
                    <td class="mono">${formatTokens(cd.tokens_after)}</td>
                    <td class="token-delta"><span class="lost">-${formatTokens(lost)}</span></td>
                    <td>
                      <div class="compact-ctx-cell">
                        <div class="compact-ctx-bar">
                          <div class="compact-ctx-fill" style=${{ width: Math.min(contextPct, 100) + "%", background: barColor }}></div>
                        </div>
                        <span class="compact-ctx-pct">${Math.round(contextPct)}%</span>
                      </div>
                    </td>
                    <td class="compact-dropped">${cd.likely_dropped.length > 0 ? cd.likely_dropped.join(", ") : "—"}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
          </div>
        </div>
      ` : compactionEvents.length > 0 && html`
        <div class="compaction-table-section">
          <div class="section-title">Compaction events</div>
          <div class="card">
          <table class="compact-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Input Tokens</th>
                <th>Context %</th>
                <th>Event Type</th>
              </tr>
            </thead>
            <tbody>
              ${compactionEvents.map((evt, i) => {
                const time = new Date(evt.timestamp).toLocaleTimeString();
                return html`
                  <tr key=${i}>
                    <td class="mono">${time}</td>
                    <td class="mono">${formatTokens(evt.input_tokens)}</td>
                    <td class=${evt.context_pct >= thresholds.dangerPct ? "text-danger" : evt.context_pct >= thresholds.warningPct ? "text-warning" : ""}>
                      ${evt.context_pct.toFixed(1)}%
                    </td>
                    <td>${evt.event_type}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
          </div>
        </div>
      `}
    </div>
  `;
}
