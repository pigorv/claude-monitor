import { useState } from "preact/hooks";
import { html } from "htm/preact";
import type { AgentRelationship, InternalToolCall, AgentEfficiencyAggregates, TokenDataPoint } from "../../../src/shared/types";

interface AgentTreeProps {
  agents: (AgentRelationship & { token_timeline?: TokenDataPoint[] })[];
  sessionStart?: string;
  agentEfficiency?: AgentEfficiencyAggregates;
}

/* ── Format helpers ──────────────────────────────────────── */

function formatDuration(ms: number | null): string {
  if (ms == null) return "\u2014";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  if (min > 0) return `${min}m ${sec % 60}s`;
  return `${sec}s`;
}

function formatOffset(agentStart: string | null, sessionStart?: string): string {
  if (!agentStart || !sessionStart) return "\u2014";
  const elapsed = new Date(agentStart).getTime() - new Date(sessionStart).getTime();
  if (elapsed < 0) return "\u2014";
  const sec = Math.floor(elapsed / 1000);
  const min = Math.floor(sec / 60);
  if (min > 0) return `+${min}m ${sec % 60}s`;
  return `+${sec}s`;
}

function formatTokens(n: number | null): string {
  if (n == null || n === 0) return "\u2014";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\u2026";
}

function toolBadgeClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("read")) return "read";
  if (lower.includes("write")) return "write";
  if (lower.includes("edit")) return "edit";
  if (lower.includes("bash")) return "bash";
  if (lower.includes("grep")) return "grep";
  if (lower.includes("glob")) return "glob";
  if (lower.includes("agent")) return "agent";
  return "";
}

function toolFillClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("read")) return "read-fill";
  if (lower.includes("write") || lower.includes("edit")) return "write-fill";
  if (lower.includes("bash")) return "bash-fill";
  if (lower.includes("glob") || lower.includes("grep")) return "glob-fill";
  return "";
}

function getDescription(agent: AgentRelationship): string {
  if (agent.prompt_preview) {
    const firstLine = agent.prompt_preview.split("\n")[0];
    return truncate(firstLine, 60);
  }
  return agent.child_agent_id;
}

/** Extract plain text from Claude content blocks JSON (e.g. [{"type":"text","text":"..."}])
 *  Handles truncated/invalid JSON by falling back to regex extraction. */
function extractResultText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Not JSON-like — return as-is
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return raw;

  // Try proper parse first
  try {
    const blocks = JSON.parse(trimmed);
    if (Array.isArray(blocks)) {
      const texts = blocks
        .filter((b: { type?: string; text?: string }) => b.type === "text" && typeof b.text === "string")
        .map((b: { text: string }) => b.text);
      if (texts.length > 0) return texts.join("\n\n");
    }
  } catch {
    // JSON is truncated — extract text via regex
  }

  // Regex fallback: pull "text":"..." values from truncated JSON
  const textParts: string[] = [];
  const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/g;
  let match;
  while ((match = re.exec(trimmed)) !== null) {
    const val = match[1]
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
    // Skip short values that are likely field names like "text" from "type":"text"
    if (val.length > 10) textParts.push(val);
  }
  if (textParts.length > 0) return textParts.join("\n\n");

  return raw;
}

/** Extract a display path for tool calls that lack file_path (e.g. Grep, Bash) */
function getToolDisplayPath(tc: InternalToolCall): string {
  if (tc.file_path) return tc.file_path;
  if (!tc.input_preview) return "\u2014";
  const lower = tc.tool_name.toLowerCase();
  if (lower.includes("grep")) {
    try {
      const parsed = JSON.parse(tc.input_preview);
      const pattern = parsed.pattern || "";
      const path = parsed.path || "";
      const shortPath = path ? path.split("/").slice(-2).join("/") : "";
      return shortPath ? `/${pattern}/ in ${shortPath}` : `/${pattern}/`;
    } catch { /* fallthrough */ }
  }
  if (lower.includes("bash")) {
    try {
      const parsed = JSON.parse(tc.input_preview);
      return truncate(parsed.command || tc.input_preview, 60);
    } catch {
      return truncate(tc.input_preview, 60);
    }
  }
  if (lower.includes("glob")) {
    try {
      const parsed = JSON.parse(tc.input_preview);
      return parsed.pattern || "\u2014";
    } catch { /* fallthrough */ }
  }
  return "\u2014";
}

/* ── Gantt helpers ───────────────────────────────────────── */

function computeGantt(agents: AgentRelationship[], sessionStart?: string) {
  if (!sessionStart) return { duration: 0 };
  const sessionMs = new Date(sessionStart).getTime();
  let maxEnd = sessionMs;
  for (const a of agents) {
    // Always prefer started_at + duration_ms (most accurate)
    if (a.started_at && a.duration_ms) {
      const end = new Date(a.started_at).getTime() + a.duration_ms;
      if (end > maxEnd) maxEnd = end;
    }
    // Also check ended_at as fallback
    if (a.ended_at) {
      const end = new Date(a.ended_at).getTime();
      if (end > maxEnd) maxEnd = end;
    }
  }
  return { duration: maxEnd - sessionMs };
}

function ganttPosition(agent: AgentRelationship, sessionStart: string, sessionDuration: number) {
  if (!agent.started_at || sessionDuration <= 0) return { left: 0, width: 2 };
  const start = new Date(agent.started_at).getTime() - new Date(sessionStart).getTime();
  const dur = agent.duration_ms || 1000;
  const left = Math.max(0, (start / sessionDuration) * 100);
  const width = Math.max(2, (dur / sessionDuration) * 100);
  return { left, width };
}

/** Compute nice time axis labels. Returns array of { label, ms } */
function computeTimeAxis(durationMs: number): { label: string; ms: number }[] {
  if (durationMs <= 0) return [];
  const totalSec = durationMs / 1000;
  // Pick interval: 10s, 30s, 1m, 2m, 5m, 10m, 15m, 30m
  const intervals = [10, 30, 60, 120, 300, 600, 900, 1800];
  let interval = 60;
  for (const iv of intervals) {
    if (totalSec / iv <= 10) { interval = iv; break; }
  }
  const ticks: { label: string; ms: number }[] = [];
  for (let s = 0; s <= totalSec; s += interval) {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    const label = s === 0 ? "0s" : min > 0 && sec === 0 ? `${min}m` : min > 0 ? `${min}m ${sec}s` : `${sec}s`;
    ticks.push({ label, ms: s * 1000 });
  }
  return ticks;
}

/* ── Agent Detail Panel ──────────────────────────────────── */

function AgentDetailPanel({
  agent,
  sessionStart,
}: {
  agent: AgentRelationship;
  sessionStart?: string;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(true);
  const [openTools, setOpenTools] = useState<Set<number>>(new Set());

  const hasPrompt = agent.prompt_data || agent.prompt_preview;
  const resultText = extractResultText(agent.result_data) || extractResultText(agent.result_preview);
  const hasResult = !!resultText;
  const toolCalls: InternalToolCall[] = agent.internal_tool_calls || [];
  const isBackground = toolCalls.length === 0 && (agent.duration_ms == null || agent.duration_ms < 100);

  const totalEstTokens = toolCalls.reduce((s, tc) => s + (tc.estimated_tokens || 0), 0);

  const toggleTool = (idx: number) => {
    const next = new Set(openTools);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setOpenTools(next);
  };

  const isFailed = agent.status === "error" || agent.status === "failed";

  return html`
    <div class="agent-detail">
      <div class="agent-detail-header">
        <span class="badge">AGENT</span>
        <span class="name">${agent.child_agent_id}</span>
        <span class="desc">\u2014 ${getDescription(agent)}</span>
        <span class="status-right">
          <span class=${"agent-status-badge " + agent.status}>${agent.status}</span>
        </span>
      </div>

      <div class="agent-detail-stats">
        <div class="stat">Started <strong>${formatOffset(agent.started_at, sessionStart)}</strong></div>
        <div class="stat">Duration <strong>${formatDuration(agent.duration_ms)}</strong></div>
        ${agent.input_tokens_total != null && html`
          <div class="stat">Prompt <strong style="color:var(--teal)">${formatTokens(agent.input_tokens_total)}</strong></div>
        `}
        ${agent.output_tokens_total != null && html`
          <div class="stat">Result <strong style="color:var(--accent)">${formatTokens(agent.output_tokens_total)}</strong></div>
        `}
        <div class="stat"><strong>${agent.tool_call_count}</strong> tool calls</div>
      </div>

      ${hasPrompt && html`
        <div class="agent-detail-section">
          <div class="section-label" onClick=${() => setPromptOpen(!promptOpen)}>
            <span>${promptOpen ? "\u25be" : "\u25b8"}</span> Prompt sent
          </div>
          <div class=${"section-content" + (promptOpen ? " expanded" : "")} onClick=${() => setPromptOpen(!promptOpen)}>
            ${agent.prompt_data || agent.prompt_preview}
            ${!promptOpen && html`<div class="fade" />`}
          </div>
        </div>
      `}

      ${hasResult && html`
        <div class="agent-detail-section">
          <div class="section-label" onClick=${() => setResultOpen(!resultOpen)}>
            <span>${resultOpen ? "\u25be" : "\u25b8"}</span> Result returned
          </div>
          <div class=${"section-content" + (resultOpen ? " expanded" : "")} onClick=${() => setResultOpen(!resultOpen)}>
            ${resultText}
            ${!resultOpen && html`<div class="fade" />`}
          </div>
        </div>
      `}

      <div class="agent-detail-section">
        <div class="tools-header">
          <span>Tool calls (${toolCalls.length})</span>
          ${totalEstTokens > 0 && html`
            <span class="tools-total">
              Total loaded: <strong style="color:var(--text2)">${formatTokens(totalEstTokens)} tokens</strong>
            </span>
          `}
        </div>

        ${totalEstTokens > 0 && html`
          <div class="tool-context-bar">
            ${toolCalls.map((tc) => {
              const pct = totalEstTokens > 0 ? ((tc.estimated_tokens || 0) / totalEstTokens * 100) : 0;
              if (pct < 0.5) return null;
              return html`<div
                class=${"tool-context-fill " + toolFillClass(tc.tool_name)}
                style=${"width:" + pct + "%"}
                title=${getToolDisplayPath(tc) + ": " + formatTokens(tc.estimated_tokens || 0) + " tokens"}
              />`;
            })}
          </div>
          <div class="context-bar-labels">
            <span>0</span>
            <span>${formatTokens(totalEstTokens)} tokens loaded into context</span>
          </div>
        `}

        ${isBackground && toolCalls.length === 0 && html`
          <div style="font-size:11px;color:var(--text3);padding:8px 0">
            Background agent \u2014 internal activity not captured in parent transcript.
          </div>
        `}

        <div class="tool-list-expanded">
          ${toolCalls.map((tc, idx) => {
            const isHeavy = (tc.estimated_tokens || 0) > 800;
            const isOpen = openTools.has(idx);
            const weightPct = totalEstTokens > 0 ? Math.min(100, ((tc.estimated_tokens || 0) / totalEstTokens) * 100) : 0;
            const weightColor = isHeavy ? "#c2410c" : (weightPct > 8 ? "#a16207" : "var(--teal)");

            return html`
              <div class=${"tool-row-exp" + (isHeavy ? " heavy" : "") + (isOpen ? " open" : "")}>
                <div class="tool-row-header" onClick=${() => toggleTool(idx)}>
                  <span class=${"tool-badge " + toolBadgeClass(tc.tool_name)}>${tc.tool_name}</span>
                  <code class="tool-path">${getToolDisplayPath(tc)}</code>
                  <span class=${"tool-tokens" + (isHeavy ? " heavy-tokens" : "")}>
                    ${tc.estimated_tokens ? formatTokens(tc.estimated_tokens) + " tok" : "\u2014"}
                  </span>
                  <span class="tool-weight-bar">
                    <span class="tool-weight-fill" style=${"width:" + weightPct + "%;background:" + weightColor} />
                  </span>
                  ${tc.duration_ms != null && html`<span class="duration">${(tc.duration_ms / 1000).toFixed(1)}s</span>`}
                  <span class="tool-expand-caret">${isOpen ? "\u25be" : "\u25b8"}</span>
                </div>
                <div class="tool-row-detail">
                  <div class="tool-detail-grid">
                    ${tc.input_preview && html`
                      <div>
                        <div class="tool-detail-label">Input</div>
                        <div class="tool-detail-content mono-content">${tc.input_preview}</div>
                      </div>
                    `}
                    ${tc.result_preview && html`
                      <div>
                        <div class="tool-detail-label">
                          Output${" "}
                          <span class=${"token-cost" + (isHeavy ? " heavy-cost" : "")}>
                            ${tc.estimated_tokens ? formatTokens(tc.estimated_tokens) + " tokens" : ""}
                            ${isHeavy && totalEstTokens > 0 ? " \u2014 " + Math.round((tc.estimated_tokens || 0) / totalEstTokens * 100) + "% of agent context" : ""}
                          </span>
                        </div>
                        <div class="tool-detail-content mono-content">${tc.result_preview}</div>
                      </div>
                    `}
                  </div>
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}

/* ── Main AgentTree ──────────────────────────────────────── */

export function AgentTree({ agents, sessionStart, agentEfficiency }: AgentTreeProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (agents.length === 0) {
    return html`<div class="status-text">No sub-agents spawned in this session.</div>`;
  }

  const sorted = [...agents].sort((a, b) => {
    const aTime = a.spawn_timestamp || a.started_at;
    const bTime = b.spawn_timestamp || b.started_at;
    if (aTime && bTime) return new Date(aTime).getTime() - new Date(bTime).getTime();
    if (aTime) return -1;
    if (bTime) return 1;
    return a.id - b.id;
  });

  const completed = sorted.filter((a) => a.status === "completed").length;
  const failed = sorted.filter((a) => a.status === "error" || a.status === "failed").length;
  const totalTokens = sorted.reduce((sum, a) => sum + (a.input_tokens_total || 0) + (a.output_tokens_total || 0), 0);
  const totalTools = sorted.reduce((sum, a) => sum + a.tool_call_count, 0);

  const gantt = computeGantt(sorted, sessionStart);
  const ticks = computeTimeAxis(gantt.duration);
  const selectedAgent = selectedId ? sorted.find((a) => a.child_agent_id === selectedId) : null;

  // Auto-select first agent if none selected
  const effectiveSelectedId = selectedId ?? (sorted.length > 0 ? sorted[0].child_agent_id : null);
  const effectiveSelectedAgent = effectiveSelectedId ? sorted.find((a) => a.child_agent_id === effectiveSelectedId) : null;

  return html`
    <div class="agent-tree">
      <!-- Summary line -->
      <div class="agents-summary">
        <span class="hl">${sorted.length}</span> sub-agent${sorted.length !== 1 ? "s" : ""}
        <span class="sep">\u00b7</span>
        <strong>${completed}</strong> completed
        ${failed > 0 && html`
          <span class="sep">\u00b7</span>
          <strong>${failed}</strong> <span style="color:var(--red);font-weight:500">failed</span>
        `}
        ${totalTokens > 0 && html`
          <span class="sep">\u00b7</span>
          <strong>${formatTokens(totalTokens)}</strong> tokens
        `}
        ${totalTools > 0 && html`
          <span class="sep">\u00b7</span>
          <strong>${totalTools}</strong> tool calls
        `}
        ${gantt.duration > 0 && html`
          <span class="sep">\u00b7</span>
          session: <strong>${formatDuration(gantt.duration)}</strong>
        `}
      </div>

      <!-- Gantt chart -->
      <div class="gantt-chart">
        <div class="gantt-header">
          <span class="gantt-title">Agent concurrency</span>
          ${gantt.duration > 0 && html`
            <span class="gantt-session-dur">Session: ${formatDuration(gantt.duration)}</span>
          `}
        </div>

        <!-- Column headers -->
        <div class="gantt-col-headers">
          <div class="gantt-col-agent">Agent</div>
          <div class="gantt-col-track">
            ${ticks.map((t) => html`
              <div class="gantt-col-tick">${t.label}</div>
            `)}
          </div>
          <div class="gantt-col-stats">
            <span class="gantt-stat-head">Tokens</span>
            <span class="gantt-stat-head">Tools</span>
            <span class="gantt-stat-head">Status</span>
          </div>
        </div>

        <!-- Agent rows -->
        ${sorted.map((agent) => {
          const pos = sessionStart ? ganttPosition(agent, sessionStart, gantt.duration) : { left: 0, width: 2 };
          const isSelected = (effectiveSelectedId) === agent.child_agent_id;
          const isFailed = agent.status === "error" || agent.status === "failed";
          const isNarrow = pos.width < 6;

          return html`
            <div
              class=${"gantt-row" + (isSelected ? " selected" : "")}
              onClick=${() => setSelectedId(agent.child_agent_id)}
            >
              <div class="gantt-label">
                <span class=${"gantt-label-id" + (isFailed ? " failed" : "")}>${agent.child_agent_id}</span>
                <span class="gantt-label-desc">${getDescription(agent)}</span>
              </div>
              <div class="gantt-track-area">
                <div class="gantt-gridlines">
                  ${ticks.map(() => html`<div class="gantt-gridline" />`)}
                </div>
                <div class=${"gantt-bar" + (isFailed ? " failed" : "") + (isNarrow ? " narrow" : "")} style=${"left:" + pos.left + "%;width:" + pos.width + "%"}>
                  <span class="gantt-bar-dur">${formatDuration(agent.duration_ms)}</span>
                </div>
              </div>
              <div class="gantt-stats">
                <div class="gantt-stat">
                  <div class="tf">
                    <span class="in">${formatTokens(agent.input_tokens_total)}</span>
                    <span class="out">${formatTokens(agent.output_tokens_total)}</span>
                  </div>
                </div>
                <div class="gantt-stat">${agent.tool_call_count}</div>
                <div class="gantt-stat">
                  <span class=${"agent-status-badge " + agent.status}>${agent.status}</span>
                </div>
              </div>
            </div>
          `;
        })}

        <!-- Time axis -->
        <div class="gantt-time-axis">
          ${ticks.map((t) => html`
            <div class="gantt-time-label">${t.label}</div>
          `)}
        </div>
      </div>

      <!-- Detail panel for selected agent -->
      ${effectiveSelectedAgent && html`
        <${AgentDetailPanel} agent=${effectiveSelectedAgent} sessionStart=${sessionStart} />
      `}
    </div>
  `;
}
