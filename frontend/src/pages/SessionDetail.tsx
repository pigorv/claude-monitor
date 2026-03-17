import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { fetchSession } from "../api/client";
import { Timeline } from "../components/Timeline";
import { TokenChart } from "../components/TokenChart";
import { AgentTree } from "../components/AgentTree";
import type { SessionDetailResponse } from "../../../src/shared/types";
import "../styles/session-detail.css";

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function modelLabel(model: string | null): string {
  if (!model) return "Unknown";
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("sonnet")) return "Sonnet";
  if (lower.includes("haiku")) return "Haiku";
  return model;
}

function formatEndTime(endedAt: string | null): string {
  if (!endedAt) return "in progress";
  const d = new Date(endedAt);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return d.toLocaleDateString();
}

function peakCtxColor(pct: number | null): string {
  if (pct == null) return "var(--text)";
  if (pct >= 90) return "var(--red)";
  if (pct >= 70) return "var(--orange)";
  if (pct >= 50) return "var(--yellow)";
  return "var(--green)";
}

function riskColor(score: number): string {
  if (score >= 0.6) return "var(--red)";
  if (score >= 0.3) return "var(--orange)";
  if (score >= 0.1) return "var(--yellow)";
  return "var(--green)";
}

function signalDotColor(value: number): string {
  if (value >= 0.3) return "var(--red)";
  if (value >= 0.1) return "var(--yellow)";
  return "var(--green)";
}

const SIGNAL_FRIENDLY_NAMES: Record<string, string> = {
  context_utilization: "context",
  compaction_count: "compactions",
  post_compaction_drift: "drift",
  long_tool_output: "tool overflow",
  deep_nesting: "nesting",
};

function friendlySignalName(name: string): string {
  return SIGNAL_FRIENDLY_NAMES[name] || name;
}

type Tab = "timeline" | "context" | "agents";

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return html`
    <button class="copy-btn" onClick=${handleCopy} title="Copy to clipboard">
      ${copied ? "Copied!" : html`
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M8 4V2.5A1.5 1.5 0 006.5 1H2.5A1.5 1.5 0 001 2.5v4A1.5 1.5 0 002.5 8H4" stroke="currentColor" stroke-width="1.1"/></svg>
        ${label || "Copy"}
      `}
    </button>
  `;
}

export function SessionDetail({ id }: { id: string }) {
  const [data, setData] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("timeline");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSession(id)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return html`<div class="page"><div class="status-text">Loading session…</div></div>`;
  }

  if (error) {
    return html`<div class="page"><div class="error-text">${error}</div></div>`;
  }

  if (!data) {
    return html`<div class="page"><div class="status-text">Session not found.</div></div>`;
  }

  const s = data.session;
  const totalTokens = s.total_input_tokens + s.total_output_tokens;
  const score = data.risk.score;
  const peakPct = s.peak_context_pct;

  // Compute compaction tokens lost
  const tokensLost = (data.compaction_details || []).reduce(
    (sum, c) => sum + Math.max(0, c.tokens_before - c.tokens_after), 0
  );

  // Top tool breakdown for stat card detail
  const toolFreq = data.stats?.tool_frequency || {};
  const topTools = Object.entries(toolFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `${count} ${name}`)
    .join(" · ");

  // Risk level label
  const riskLabel = score >= 0.6 ? "high risk" : score >= 0.3 ? "medium risk" : score >= 0.1 ? "low risk" : "minimal risk";

  // Peak context threshold label
  const peakCtxLabel = peakPct != null
    ? (peakPct >= 90 ? "critical" : peakPct >= 70 ? "warning" : peakPct >= 50 ? "elevated" : "safe")
    : null;
  const peakCtxThreshold = peakPct != null
    ? (peakPct >= 70 ? "threshold 70%" : "threshold 60%")
    : null;

  return html`
    <div class="page session-detail">
      <div class="session-header">
        <div class="breadcrumb">
          <a href="#/">Sessions</a>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="opacity:0.4"><path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span style="color:var(--text3)">${s.project_name || 'Unknown'}</span>
        </div>
        <h1 class="session-title">${s.summary || s.project_name || 'Session'}</h1>
        <div class="session-subtitle">
          <span class="model-tag">${modelLabel(s.model)}</span>
          <span class="sep">·</span>
          <span class="meta-item">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="color:var(--text3)"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.5V6L7.5 7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            ${formatDuration(s.duration_ms)}
          </span>
          <span class="sep">·</span>
          ${formatTokens(totalTokens)} tokens
          <span class="sep">·</span>
          ${s.tool_call_count} tool calls
          <span class="sep">·</span>
          <span style="color:var(--text3)">ended ${formatEndTime(s.ended_at)}</span>
        </div>
      </div>

      ${data.linked_sessions && data.linked_sessions.length > 0 && html`
        <div class="linked-sessions">
          ${data.linked_sessions.map(ls => html`
            <a class="linked-session-link" href="#/session/${ls.session_id}">
              <span class="linked-label">${ls.relationship === 'planning_session' ? 'Planning Session' : 'Implementation Session'}</span>
              <span class="linked-summary">${ls.summary || ls.project_name || ls.session_id.slice(0, 8)}</span>
              <span class="linked-meta">${formatDuration(ls.duration_ms)}</span>
              <span class="linked-arrow">\u2192</span>
            </a>
          `)}
        </div>
      `}

      <div class="resume-row">
        <div class="resume-cmd">
          <span class="resume-cmd-dollar">$</span>
          <code class="resume-cmd-text">claude --resume ${s.id}</code>
          <${CopyButton} text=${"claude --resume " + s.id} label="Copy" />
        </div>
      </div>

      <div class="stats stats-4">
        <div class="stat-card compact">
          <div class="label">Peak Context</div>
          <div class="value" style="color: ${peakCtxColor(peakPct)}">${peakPct != null ? Math.round(peakPct) + "%" : "—"}</div>
          ${peakCtxLabel && html`<div class="detail">${peakCtxLabel} — ${peakCtxThreshold}</div>`}
          ${peakPct != null && html`
            <div class="progress">
              <div class="fill" style="width: ${Math.min(peakPct, 100)}%; background: ${peakCtxColor(peakPct)}"></div>
            </div>
          `}
        </div>
        <div class="stat-card compact">
          <div class="label">Compactions</div>
          <div class="value" style="color: ${s.compaction_count > 0 ? 'var(--orange)' : 'var(--text)'}">${s.compaction_count}</div>
          ${tokensLost > 0
            ? html`<div class="detail">~${formatTokens(tokensLost)} tokens lost</div>`
            : html`<div class="detail" style="color: var(--green)">none triggered</div>`
          }
        </div>
        <div class="stat-card compact">
          <div class="label">Tool Calls</div>
          <div class="value">${s.tool_call_count}</div>
          ${topTools && html`<div class="detail">${topTools}</div>`}
        </div>
        <div class="stat-card compact">
          <div class="label">Risk Score</div>
          <div class="value" style="color: ${riskColor(score)}">${score.toFixed(2)}</div>
          <div class="detail">${riskLabel}</div>
          <div class="progress">
            <div class="fill" style="width: ${Math.min(score * 100, 100)}%; background: ${riskColor(score)}"></div>
          </div>
        </div>
      </div>

      <div class="tab-bar">
        <button
          class=${tab === "timeline" ? "tab active" : "tab"}
          onClick=${() => setTab("timeline")}
        >
          Timeline${data.event_count != null ? html`<span class="count">${data.event_count}</span>` : ''}
        </button>
        <button
          class=${tab === "context" ? "tab active" : "tab"}
          onClick=${() => setTab("context")}
        >
          Context
        </button>
        <button
          class=${tab === "agents" ? "tab active" : "tab"}
          onClick=${() => setTab("agents")}
        >
          Agents${s.subagent_count > 0 ? html`<span class="count">${s.subagent_count}</span>` : ''}
        </button>
      </div>

      <div class="tab-content">
        ${tab === "timeline" && html`
          <${Timeline} sessionId=${id} sessionStart=${s.started_at} agents=${data.agents} parentInputTokens=${s.total_input_tokens} parentOutputTokens=${s.total_output_tokens} />
        `}
        ${tab === "context" && html`
          ${data.risk.signals.length > 0 && html`
            <div class="risk-signals">
              ${data.risk.signals.map(
                (sig) => html`
                  <span class="signal-badge" title=${sig.description}>
                    <span class="signal-dot" style="background: ${signalDotColor(sig.value * sig.weight)}"></span>
                    ${friendlySignalName(sig.name)}: ${(sig.value * sig.weight).toFixed(2)}
                  </span>
                `
              )}
            </div>
          `}
          <${TokenChart} timeline=${data.token_timeline} model=${s.model} compactionDetails=${data.compaction_details} />
        `}
        ${tab === "agents" && html`
          <${AgentTree} agents=${data.agents} sessionStart=${s.started_at} agentEfficiency=${data.agent_efficiency} />
        `}
      </div>
    </div>
  `;
}
