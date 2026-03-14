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

/* ── Gantt bar helpers ───────────────────────────────────── */

function computeGantt(agents: AgentRelationship[], sessionStart?: string) {
  if (!sessionStart) return { duration: 0 };
  const sessionMs = new Date(sessionStart).getTime();
  let maxEnd = sessionMs;
  for (const a of agents) {
    if (a.ended_at) {
      const end = new Date(a.ended_at).getTime();
      if (end > maxEnd) maxEnd = end;
    } else if (a.started_at && a.duration_ms) {
      const end = new Date(a.started_at).getTime() + a.duration_ms;
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

/* ── Agent Detail Panel ──────────────────────────────────── */

function AgentDetailPanel({
  agent,
  sessionStart,
}: {
  agent: AgentRelationship;
  sessionStart?: string;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [openTools, setOpenTools] = useState<Set<number>>(new Set());

  const hasPrompt = agent.prompt_data || agent.prompt_preview;
  const hasResult = agent.result_data || agent.result_preview;
  const toolCalls: InternalToolCall[] = agent.internal_tool_calls || [];
  const isBackground = toolCalls.length === 0 && (agent.duration_ms == null || agent.duration_ms < 100);

  const totalEstTokens = toolCalls.reduce((s, tc) => s + (tc.estimated_tokens || 0), 0);

  const toggleTool = (idx: number) => {
    const next = new Set(openTools);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    setOpenTools(next);
  };

  return html`
    <div class="agent-detail">
      <div class="agent-detail-header">
        <span class="badge">AGENT</span>
        <span class="name">${agent.child_agent_id}</span>
        <span class="desc">\u2014 ${getDescription(agent)}</span>
        <span class="status">
          <span class=${"agent-status-badge " + agent.status}>${agent.status}</span>
        </span>
      </div>

      <div class="agent-detail-stats">
        <div class="stat">Started <strong>${formatOffset(agent.started_at, sessionStart)}</strong> into session</div>
        <div class="stat">Duration <strong>${formatDuration(agent.duration_ms)}</strong></div>
        ${agent.input_tokens_total != null && html`
          <div class="stat">Prompt <strong style="color:var(--teal)">${formatTokens(agent.input_tokens_total)} tokens</strong></div>
        `}
        ${agent.output_tokens_total != null && html`
          <div class="stat">Result <strong style="color:var(--accent)">${formatTokens(agent.output_tokens_total)} tokens</strong></div>
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
            ${agent.result_data || agent.result_preview}
            ${!resultOpen && html`<div class="fade" />`}
          </div>
        </div>
      `}

      <div class="agent-detail-section">
        <div class="section-label">
          <span>Tool calls (${toolCalls.length})</span>
          ${totalEstTokens > 0 && html`
            <span style="margin-left:auto;font-size:10px;font-family:var(--mono);color:var(--text3)">
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
                title=${(tc.file_path || tc.tool_name) + ": " + formatTokens(tc.estimated_tokens || 0) + " tokens"}
              />`;
            })}
          </div>
          <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3);font-family:var(--mono);margin-bottom:12px">
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
                  <code class="tool-path">${tc.file_path || "\u2014"}</code>
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
  const totalTokens = sorted.reduce((sum, a) => sum + (a.input_tokens_total || 0) + (a.output_tokens_total || 0), 0);
  const totalTools = sorted.reduce((sum, a) => sum + a.tool_call_count, 0);
  const durations = sorted.filter((a) => a.duration_ms != null).map((a) => a.duration_ms!);
  const longest = durations.length > 0 ? Math.max(...durations) : null;

  const gantt = computeGantt(sorted, sessionStart);
  const selectedAgent = selectedId ? sorted.find((a) => a.child_agent_id === selectedId) : null;

  return html`
    <div class="agent-tree">
      <!-- Summary line -->
      <div class="agents-summary">
        <span class="hl">${sorted.length}</span> sub-agent${sorted.length !== 1 ? "s" : ""}
        <span class="sep">\u00b7</span>
        <strong>${completed}</strong> completed
        ${totalTokens > 0 && html`
          <span class="sep">\u00b7</span>
          <strong>${formatTokens(totalTokens)}</strong> tokens consumed
        `}
        ${totalTools > 0 && html`
          <span class="sep">\u00b7</span>
          <strong>${totalTools}</strong> tool calls
        `}
        ${longest != null && html`
          <span class="sep">\u00b7</span>
          longest: <strong>${formatDuration(longest)}</strong>
        `}
      </div>

      <!-- Agent table -->
      <table class="agent-table">
        <colgroup>
          <col style="width:22%" />
          <col style="width:30%" />
          <col style="width:12%" />
          <col style="width:16%" />
          <col style="width:8%" />
          <col style="width:12%" />
        </colgroup>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Description</th>
            <th>Timing</th>
            <th>Tokens</th>
            <th>Tools</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map((agent) => {
            const pos = sessionStart ? ganttPosition(agent, sessionStart, gantt.duration) : null;
            const isSelected = selectedId === agent.child_agent_id;
            return html`
              <tr
                class=${isSelected ? "selected" : ""}
                onClick=${() => setSelectedId(isSelected ? null : agent.child_agent_id)}
              >
                <td class="agent-id-cell">${agent.child_agent_id}</td>
                <td>
                  <div class="agent-desc-cell">${getDescription(agent)}</div>
                  ${pos && html`
                    <div style="margin-top:6px">
                      <div class="gantt-bar-container">
                        <div class="gantt-bar" style=${"left:" + pos.left + "%;width:" + pos.width + "%"} />
                      </div>
                    </div>
                  `}
                </td>
                <td class="agent-timing">
                  ${formatOffset(agent.started_at, sessionStart)}
                  <br />
                  <span style="color:var(--text2)">${formatDuration(agent.duration_ms)}</span>
                </td>
                <td>
                  <div class="token-flow">
                    <span class="in">\u2190 ${formatTokens(agent.input_tokens_total)}</span>
                    <span class="out">${formatTokens(agent.output_tokens_total)} \u2192</span>
                  </div>
                </td>
                <td class="agent-mono">${agent.tool_call_count}</td>
                <td><span class=${"agent-status-badge " + agent.status}>${agent.status}</span></td>
              </tr>
            `;
          })}
        </tbody>
      </table>

      <!-- Detail panel for selected agent -->
      ${selectedAgent && html`
        <${AgentDetailPanel} agent=${selectedAgent} sessionStart=${sessionStart} />
      `}
    </div>
  `;
}
