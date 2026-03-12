import { useState } from "preact/hooks";
import { html } from "htm/preact";
import type { AgentRelationship, TokenDataPoint } from "../../../src/shared/types";

// ── Types ──────────────────────────────────────────────────────────

interface AgentEfficiencyAggregates {
  total_agents: number;
  aggregate_tokens: number;
  avg_compression_ratio: number | null;
  agents_with_compaction: number;
  parent_pressure_events: number;
  avg_agent_duration_ms: number | null;
  peak_concurrency: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function formatTokens(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function compressionRating(ratio: number | null): { label: string; color: string } {
  if (ratio == null || ratio <= 0) return { label: "—", color: "var(--text3)" };
  if (ratio > 20) return { label: "Excellent", color: "var(--green)" };
  if (ratio > 5) return { label: "Good", color: "var(--green)" };
  if (ratio > 2) return { label: "Fair", color: "var(--yellow)" };
  return { label: "Poor", color: "var(--red)" };
}

function resultBadgeClass(classification: string | null): string {
  if (!classification) return "";
  if (classification === "oversized") return "result-badge-red";
  if (classification === "large") return "result-badge-yellow";
  return "result-badge-green";
}

// ── Agent Efficiency Dashboard ────────────────────────────────────

interface DashboardProps {
  agents: AgentRelationship[];
  efficiency?: AgentEfficiencyAggregates;
}

export function AgentEfficiencyDashboard({ agents, efficiency }: DashboardProps) {
  if (!efficiency || agents.length < 2) return null;

  const { label: compLabel, color: compColor } = compressionRating(efficiency.avg_compression_ratio);

  return html`
    <div class="agent-efficiency-dashboard">
      <div class="efficiency-stat">
        <div class="efficiency-stat-value" style="color: var(--teal)">${efficiency.total_agents}</div>
        <div class="efficiency-stat-label">Total Agents</div>
      </div>
      <div class="efficiency-stat">
        <div class="efficiency-stat-value">${formatTokens(efficiency.aggregate_tokens)}</div>
        <div class="efficiency-stat-label">Tokens Consumed</div>
      </div>
      <div class="efficiency-stat">
        <div class="efficiency-stat-value" style="color: ${compColor}">
          ${efficiency.avg_compression_ratio != null ? `${efficiency.avg_compression_ratio.toFixed(1)}:1` : "—"}
        </div>
        <div class="efficiency-stat-label">Avg Compression</div>
        ${efficiency.avg_compression_ratio != null && html`
          <div class="efficiency-stat-sub" style="color: ${compColor}">${compLabel}</div>
        `}
      </div>
      <div class="efficiency-stat">
        <div class="efficiency-stat-value" style="color: ${efficiency.agents_with_compaction > 0 ? 'var(--orange)' : 'var(--text)'}">${efficiency.agents_with_compaction}</div>
        <div class="efficiency-stat-label">Compacted</div>
      </div>
      <div class="efficiency-stat">
        <div class="efficiency-stat-value" style="color: ${efficiency.parent_pressure_events > 0 ? 'var(--red)' : 'var(--text)'}">${efficiency.parent_pressure_events}</div>
        <div class="efficiency-stat-label">Pressure Events</div>
      </div>
      <div class="efficiency-stat">
        <div class="efficiency-stat-value">${formatDuration(efficiency.avg_agent_duration_ms)}</div>
        <div class="efficiency-stat-label">Avg Duration</div>
      </div>
    </div>
  `;
}

// ── Concurrency Timeline (SVG swim lanes) ─────────────────────────

interface TimelineProps {
  agents: AgentRelationship[];
  sessionStart: string;
  onAgentClick?: (agentId: string) => void;
}

export function ConcurrencyTimeline({ agents, sessionStart, onAgentClick }: TimelineProps) {
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  if (agents.length === 0) return null;

  const sessionStartMs = new Date(sessionStart).getTime();
  const validAgents = agents.filter(a => a.started_at && a.ended_at);

  if (validAgents.length === 0) return null;

  const allTimes = validAgents.flatMap(a => [
    new Date(a.started_at!).getTime(),
    new Date(a.ended_at!).getTime(),
  ]);
  const minTime = Math.min(sessionStartMs, ...allTimes);
  const maxTime = Math.max(...allTimes);
  const totalDuration = maxTime - minTime;

  if (totalDuration <= 0) return null;

  const PADDING_LEFT = 120;
  const PADDING_RIGHT = 20;
  const CHART_WIDTH = 700;
  const ROW_HEIGHT = 36;
  const BAR_HEIGHT = 20;
  const HEADER_HEIGHT = 24;
  const svgWidth = CHART_WIDTH + PADDING_LEFT + PADDING_RIGHT;
  const svgHeight = HEADER_HEIGHT + validAgents.length * ROW_HEIGHT + 20;
  const chartW = CHART_WIDTH;

  const timeToX = (ms: number) => PADDING_LEFT + ((ms - minTime) / totalDuration) * chartW;

  const timeLabels: Array<{ x: number; label: string }> = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = minTime + (totalDuration * i) / steps;
    const elapsed = Math.floor((t - sessionStartMs) / 1000);
    const min = Math.floor(elapsed / 60);
    const sec = elapsed % 60;
    timeLabels.push({
      x: timeToX(t),
      label: min > 0 ? `${min}m${sec}s` : `${sec}s`,
    });
  }

  return html`
    <div class="concurrency-timeline">
      <div class="concurrency-timeline-header">
        <span class="agent-section-title">Concurrency Timeline</span>
      </div>
      <div class="concurrency-timeline-scroll">
        <svg width=${svgWidth} height=${svgHeight} class="concurrency-svg">
          ${timeLabels.map(({ x, label }) => html`
            <line x1=${x} y1=${HEADER_HEIGHT} x2=${x} y2=${svgHeight - 10} stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,3" />
            <text x=${x} y=${HEADER_HEIGHT - 4} text-anchor="middle" fill="var(--text3)" font-size="10" font-family="var(--mono)">${label}</text>
          `)}

          ${validAgents.map((agent, i) => {
            const y = HEADER_HEIGHT + i * ROW_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
            const startX = timeToX(new Date(agent.started_at!).getTime());
            const endX = timeToX(new Date(agent.ended_at!).getTime());
            const barWidth = Math.max(endX - startX, 4);
            const isHovered = hoveredAgent === agent.child_agent_id;
            const classification = agent.result_classification;
            const barColor = classification === 'oversized' ? 'var(--red)' :
                           classification === 'large' ? 'var(--yellow)' : 'var(--teal)';
            const label = (agent.prompt_preview || agent.child_agent_id).slice(0, 18);

            return html`
              <g
                class="swim-lane-group"
                onMouseEnter=${() => setHoveredAgent(agent.child_agent_id)}
                onMouseLeave=${() => setHoveredAgent(null)}
                onClick=${() => onAgentClick?.(agent.child_agent_id)}
                style="cursor: pointer"
              >
                ${isHovered && html`
                  <rect x=${0} y=${HEADER_HEIGHT + i * ROW_HEIGHT} width=${svgWidth} height=${ROW_HEIGHT} fill="var(--bg-hover)" rx="4" />
                `}

                <text
                  x=${PADDING_LEFT - 8}
                  y=${y + BAR_HEIGHT / 2 + 4}
                  text-anchor="end"
                  fill=${isHovered ? "var(--text)" : "var(--text2)"}
                  font-size="11"
                  font-family="var(--mono)"
                >${label}</text>

                <rect
                  x=${startX}
                  y=${y}
                  width=${barWidth}
                  height=${BAR_HEIGHT}
                  rx="4"
                  fill=${barColor}
                  opacity=${isHovered ? 1 : 0.75}
                />

                ${agent.agent_compaction_count > 0 && html`
                  <polygon
                    points="${startX + barWidth * 0.6 - 4},${y - 2} ${startX + barWidth * 0.6 + 4},${y - 2} ${startX + barWidth * 0.6},${y + 4}"
                    fill="var(--orange)"
                  />
                `}

                ${barWidth > 50 && agent.compression_ratio != null && html`
                  <text
                    x=${startX + barWidth / 2}
                    y=${y + BAR_HEIGHT / 2 + 4}
                    text-anchor="middle"
                    fill="white"
                    font-size="10"
                    font-weight="600"
                    font-family="var(--mono)"
                  >${agent.compression_ratio.toFixed(1)}:1</text>
                `}

                ${isHovered && html`
                  <foreignObject x=${startX + barWidth + 8} y=${y - 10} width="200" height="80">
                    <div class="swim-tooltip">
                      <div class="swim-tooltip-title">${agent.prompt_preview || agent.child_agent_id}</div>
                      <div class="swim-tooltip-row">Duration: ${formatDuration(agent.duration_ms)}</div>
                      ${agent.compression_ratio != null && html`
                        <div class="swim-tooltip-row">Compression: ${agent.compression_ratio.toFixed(1)}:1</div>
                      `}
                      ${agent.result_tokens != null && html`
                        <div class="swim-tooltip-row">Result: ${formatTokens(agent.result_tokens)} tokens</div>
                      `}
                    </div>
                  </foreignObject>
                `}
              </g>
            `;
          })}
        </svg>
      </div>
    </div>
  `;
}

// ── Efficiency Metrics Row (for inside AgentCard) ─────────────────

interface EfficiencyMetricsProps {
  agent: AgentRelationship;
}

export function EfficiencyMetrics({ agent }: EfficiencyMetricsProps) {
  const hasData = agent.compression_ratio != null || agent.result_tokens != null;
  if (!hasData) return null;

  const { color: compColor } = compressionRating(agent.compression_ratio);
  const badgeClass = resultBadgeClass(agent.result_classification);

  return html`
    <div class="efficiency-metrics-row">
      ${agent.prompt_tokens != null && html`
        <div class="efficiency-metric">
          <span class="efficiency-metric-label">Prompt</span>
          <span class="efficiency-metric-value">${formatTokens(agent.prompt_tokens)}</span>
        </div>
      `}
      ${agent.peak_context_tokens != null && html`
        <div class="efficiency-metric">
          <span class="efficiency-metric-label">Context</span>
          <span class="efficiency-metric-value">${formatTokens(agent.peak_context_tokens)}</span>
        </div>
      `}
      ${agent.result_tokens != null && html`
        <div class="efficiency-metric">
          <span class="efficiency-metric-label">Result</span>
          <span class="efficiency-metric-value">${formatTokens(agent.result_tokens)}</span>
        </div>
      `}
      ${agent.compression_ratio != null && html`
        <div class="efficiency-metric">
          <span class="efficiency-metric-label">Compression</span>
          <span class="efficiency-metric-value" style="color: ${compColor}">${agent.compression_ratio.toFixed(1)}:1</span>
        </div>
      `}
      ${agent.parent_impact_pct != null && html`
        <div class="efficiency-metric">
          <span class="efficiency-metric-label">Parent Impact</span>
          <span class=${"efficiency-metric-value " + badgeClass}>${agent.parent_impact_pct.toFixed(1)}%</span>
        </div>
      `}
      ${agent.result_classification && agent.result_classification !== 'normal' && html`
        <span class=${"result-badge " + badgeClass}>${agent.result_classification}</span>
      `}
    </div>
  `;
}

// ── Mini Context Chart (sparkline for agent card) ─────────────────

interface MiniChartProps {
  timeline: TokenDataPoint[];
}

export function MiniContextChart({ timeline }: MiniChartProps) {
  if (!timeline || timeline.length < 2) return null;

  const WIDTH = 280;
  const HEIGHT = 60;
  const PADDING = 4;

  const maxTokens = Math.max(...timeline.map(p => p.input_tokens));
  if (maxTokens === 0) return null;

  const points = timeline.map((p, i) => {
    const x = PADDING + (i / (timeline.length - 1)) * (WIDTH - 2 * PADDING);
    const y = HEIGHT - PADDING - (p.input_tokens / maxTokens) * (HEIGHT - 2 * PADDING);
    return { x, y, isCompaction: p.is_compaction };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');

  return html`
    <div class="mini-context-chart">
      <svg width=${WIDTH} height=${HEIGHT} class="mini-chart-svg">
        <rect x=${PADDING} y=${PADDING} width=${WIDTH - 2 * PADDING} height=${(HEIGHT - 2 * PADDING) * 0.3} fill="color-mix(in srgb, var(--red) 5%, transparent)" rx="2" />
        <path d=${linePath} fill="none" stroke="var(--teal)" stroke-width="1.5" />
        ${points.filter(p => p.isCompaction).map(p => html`
          <circle cx=${p.x} cy=${p.y} r="3" fill="var(--orange)" />
        `)}
      </svg>
      <div class="mini-chart-labels">
        <span>0</span>
        <span>${formatTokens(maxTokens)}</span>
      </div>
    </div>
  `;
}
