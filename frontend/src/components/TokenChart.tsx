import { useRef, useEffect, useState, useCallback, useMemo } from "preact/hooks";
import { html } from "htm/preact";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { TokenDataPoint, CompactionDetail, Session, FileActivityData, EventAnnotation } from "../../../src/shared/types";
import {
  resolveThresholds,
  transformTimeline,
  buildChartOpts,
  computeYScale,
} from "../lib/chart-config";

interface TokenChartProps {
  timeline: TokenDataPoint[];
  model: string | null | undefined;
  compactionDetails?: CompactionDetail[];
  session: Session;
  fileActivity?: FileActivityData;
  eventAnnotations?: EventAnnotation[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function splitFilePath(fullPath: string): { dir: string; name: string } {
  const lastSlash = fullPath.lastIndexOf("/");
  if (lastSlash < 0) return { dir: "", name: fullPath };
  return { dir: fullPath.slice(0, lastSlash + 1), name: fullPath.slice(lastSlash + 1) };
}

function formatTime(isoTimestamp: string): string {
  return new Date(isoTimestamp).toLocaleTimeString("en-US", { hour12: false });
}

export function TokenChart({ timeline, model, compactionDetails, session, fileActivity, eventAnnotations }: TokenChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 220 });

  const thresholds = resolveThresholds(model);
  const chartData = transformTimeline(timeline, thresholds.maxTokens, eventAnnotations);
  const yScale = useMemo(() => computeYScale(chartData.contextPct, thresholds), [chartData.contextPct, thresholds]);

  // Resize observer on the outer wrapper
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    const updateSize = () => {
      const style = getComputedStyle(el);
      const contentWidth = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (contentWidth > 0) {
        setDimensions({ width: contentWidth, height: 220 });
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
      chartData.contextPct,
      chartData.cacheReadPct,
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

  const modelName = model ? (model.toLowerCase().includes("opus") ? "Opus" : model.toLowerCase().includes("sonnet") ? "Sonnet" : model.toLowerCase().includes("haiku") ? "Haiku" : model) : "unknown";

  // File activity toggle: main-only (default) vs including subagents
  const [includeSubagents, setIncludeSubagents] = useState(false);

  const { activeFiles, rereadFiles, maxFileTokens, totalRereadTokens, rereadAfterCompactionCount } = useMemo(() => {
    if (!fileActivity) return { activeFiles: [], rereadFiles: [], maxFileTokens: 0, totalRereadTokens: 0, rereadAfterCompactionCount: 0 };
    const activeFiles = includeSubagents ? fileActivity.files_with_subagents : fileActivity.files;
    const rereadFiles = activeFiles.filter(f => f.read_count >= 2);
    const maxFileTokens = activeFiles.length ? Math.max(...activeFiles.map(f => f.total_tokens)) : 0;
    const totalRereadTokens = includeSubagents ? fileActivity.total_reread_tokens_with_subagents : fileActivity.total_reread_tokens;
    const rereadAfterCompactionCount = includeSubagents ? fileActivity.reread_after_compaction_count_with_subagents : fileActivity.reread_after_compaction_count;
    return { activeFiles, rereadFiles, maxFileTokens, totalRereadTokens, rereadAfterCompactionCount };
  }, [fileActivity, includeSubagents]);

  // Compaction table
  const hasCompactionDetails = compactionDetails && compactionDetails.length > 0;
  const compactionEvents = timeline.filter((p) => p.is_compaction);
  const hasCompactionEvents = compactionEvents.length > 0;

  return html`
    <div class="context-tab">

      <!-- Context utilization chart -->
      <div class="context-card">
        <div class="context-card-header">
          <div class="section-title">Context utilization over time</div>
          <div class="chart-subtitle">${modelName} \u00b7 ${formatTokens(thresholds.maxTokens)} window</div>
        </div>
        <div class="context-card-body">
          <div class="chart-container" ref=${wrapperRef}>
            <div class="chart-header">
              <div class="chart-legend">
                <span class="legend-item"><span class="legend-dot" style="background:#6d28d9"></span> Context %</span>
                <span class="legend-item"><span class="legend-dot" style="background:rgba(14,116,144,0.6)"></span> Cache read</span>
                <span class="legend-item"><span class="legend-dot legend-dot-zone" style="background:rgba(161,98,7,0.15); border: 1px solid rgba(161,98,7,0.3)"></span> Warning</span>
                <span class="legend-item"><span class="legend-dot legend-dot-zone" style="background:rgba(185,28,28,0.1); border: 1px solid rgba(185,28,28,0.25)"></span> Danger</span>
                <span class="legend-sep">|</span>
                <span class="legend-item"><span class="legend-dot legend-dot-line" style="background:#b91c1c"></span> Compaction</span>
              </div>
            </div>
            <div class="chart-canvas-wrap" ref=${canvasRef}></div>
            ${(!yScale.warningVisible || !yScale.dangerVisible) && html`
              <div class="threshold-badge">
                ${!yScale.warningVisible && html`<div class="threshold-pill warn"><span class="threshold-arrow">\u25B2</span> warning ${thresholds.warningPct}%</div>`}
                ${!yScale.dangerVisible && html`<div class="threshold-pill danger"><span class="threshold-arrow">\u25B2</span> danger ${thresholds.dangerPct}%</div>`}
              </div>
            `}
          </div>
        </div>
      </div>

      <!-- File Activity Section -->
      ${fileActivity && activeFiles.length > 0 && html`
        <div class="section-label-row">
          <span class="section-label">File Activity</span>
          <div class="section-label-line"></div>
        </div>

        ${rereadFiles.length > 0 && html`
          <div class="insight-card insight-card-orange">
            <div class="insight-icon">\u27F3</div>
            <div class="insight-body">
              <div class="insight-title">${rereadFiles.length} file${rereadFiles.length !== 1 ? "s" : ""} read more than once \u2014 ${formatTokens(totalRereadTokens)} tokens from repeated reads</div>
              ${rereadAfterCompactionCount > 0 && html`
                <div class="insight-desc">
                  <strong>${rereadAfterCompactionCount} file${rereadAfterCompactionCount !== 1 ? "s" : ""}</strong> re-read after a compaction event, meaning Claude likely lost the file content and reloaded it.
                </div>
              `}
              <div class="insight-files">
                ${rereadFiles.map(f => {
                  const { name } = splitFilePath(f.file_path);
                  return html`<span class="insight-file-chip">${name} \u00d7${f.read_count}</span>`;
                })}
              </div>
            </div>
          </div>
        `}

        <div class="file-lifecycle">
          <div class="fl-header">
            <div class="fl-title">File lifecycle</div>
            <label class="toggle-switch" onClick=${(e: Event) => { e.preventDefault(); setIncludeSubagents((v: boolean) => !v); }}>
              <span class="toggle-track ${includeSubagents ? "on" : ""}">
                <span class="toggle-thumb"></span>
              </span>
              <span class="toggle-label">Sub-agents</span>
            </label>
            <div class="fl-summary">${activeFiles.length} files \u00b7 ${formatTokens(activeFiles.reduce((s, f) => s + f.total_tokens, 0))} tokens loaded</div>
          </div>
          <table class="fl-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Reads</th>
                <th>Flags</th>
                <th class="right">Tokens (total)</th>
                <th class="right">First Read</th>
              </tr>
            </thead>
            <tbody>
              ${activeFiles.map(f => {
                const { dir, name } = splitFilePath(f.file_path);
                const barPct = maxFileTokens > 0 ? Math.round((f.total_tokens / maxFileTokens) * 100) : 0;
                const isHeavy = f.read_count >= 2;
                return html`
                  <tr>
                    <td><div class="file-path"><span class="file-dir">${dir}</span><span class="file-name">${name}</span></div></td>
                    <td><span class="read-count ${f.read_count >= 2 ? "read-multi" : "read-once"}">\u00d7${f.read_count}</span></td>
                    <td>
                      <div class="fl-flags">
                        ${f.is_reread_after_compaction && html`<span class="fl-flag flag-reread">re-read after compaction</span>`}
                        ${f.has_partial && html`<span class="fl-flag flag-partial">partial</span>`}
                        ${f.is_skill_file && html`<span class="fl-flag flag-skill">skill</span>`}
                      </div>
                    </td>
                    <td class="right">
                      <div class="tok-bar-cell" style="justify-content: flex-end;">
                        <span class="tok-value">${formatTokens(f.total_tokens)}</span>
                        <div class="tok-bar"><div class="tok-bar-fill ${isHeavy ? "heavy" : ""}" style="width: ${barPct}%"></div></div>
                      </div>
                    </td>
                    <td class="right mono">${formatTime(f.first_read)}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>
      `}

      <!-- Compaction History Section -->
      <div class="section-label-row">
        <span class="section-label">Compaction History</span>
        <div class="section-label-line"></div>
      </div>

      ${hasCompactionDetails ? html`
        <div class="compaction-card">
          <div class="compaction-header">
            <div class="compaction-title">Compaction details</div>
            <span class="compaction-count-badge">${compactionDetails!.length} event${compactionDetails!.length !== 1 ? "s" : ""}</span>
          </div>
          <table class="compact-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Trigger</th>
                <th>Before</th>
                <th>After</th>
                <th>Tokens Lost</th>
              </tr>
            </thead>
            <tbody>
              ${compactionDetails!.map((cd, i) => {
                const time = formatTime(cd.timestamp);
                const lost = cd.tokens_before - cd.tokens_after;
                return html`
                  <tr key=${i}>
                    <td class="mono">${i + 1}</td>
                    <td class="mono">${time}</td>
                    <td><span class="trigger-badge ${cd.trigger === "auto" ? "auto" : "manual"}">${cd.trigger}</span></td>
                    <td class="mono">${formatTokens(cd.tokens_before)}</td>
                    <td class="mono">${formatTokens(cd.tokens_after)}</td>
                    <td class="token-delta"><span class="lost">\u2212${formatTokens(lost)}</span></td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>
      ` : hasCompactionEvents ? html`
        <div class="compaction-card">
          <div class="compaction-header">
            <div class="compaction-title">Compaction details</div>
            <span class="compaction-count-badge">${compactionEvents.length} event${compactionEvents.length !== 1 ? "s" : ""}</span>
          </div>
          <table class="compact-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Time</th>
                <th>Input Tokens</th>
                <th>Context %</th>
              </tr>
            </thead>
            <tbody>
              ${compactionEvents.map((evt, i) => {
                const time = formatTime(evt.timestamp);
                return html`
                  <tr key=${i}>
                    <td class="mono">${i + 1}</td>
                    <td class="mono">${time}</td>
                    <td class="mono">${formatTokens(evt.input_tokens)}</td>
                    <td class=${evt.context_pct >= thresholds.dangerPct ? "text-danger" : evt.context_pct >= thresholds.warningPct ? "text-warning" : ""}>
                      ${evt.context_pct.toFixed(1)}%
                    </td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>
      ` : html`
        <div class="compaction-card">
          <div class="compaction-card-empty">
            <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <div class="empty-title">No compactions triggered</div>
            <div class="empty-subtitle">Context stayed within threshold for the entire session.</div>
          </div>
        </div>
      `}
    </div>
  `;
}
