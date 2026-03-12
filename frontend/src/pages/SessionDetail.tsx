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
      ${copied ? "Copied!" : label || "Copy"}
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

  return html`
    <div class="page session-detail">
      <div class="session-header">
        <div class="breadcrumb"><a href="#/">Sessions</a> / ${s.project_name || 'Unknown'}</div>
        <h1>${modelLabel(s.model)} · ${s.project_name || 'Session'}</h1>
        ${s.summary && html`<p class="session-summary">${s.summary}</p>`}
        <p class="page-sub">${formatDuration(s.duration_ms)} · ${formatTokens(totalTokens)} tokens · ended ${formatEndTime(s.ended_at)}</p>
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

      <div class="resume-cmd">
        <span class="resume-cmd-dollar">$</span>
        <code class="resume-cmd-text">claude --resume ${s.id}</code>
        <${CopyButton} text=${"claude --resume " + s.id} label="Copy" />
      </div>

      <div class="stats stats-4">
        <div class="stat-card compact">
          <div class="label">Peak Context</div>
          <div class="value" style="color: ${peakCtxColor(peakPct)}">${peakPct != null ? Math.round(peakPct) + "%" : "—"}</div>
          ${peakPct != null && html`
            <div class="progress">
              <div class="fill" style="width: ${Math.min(peakPct, 100)}%; background: ${peakCtxColor(peakPct)}"></div>
            </div>
          `}
        </div>
        <div class="stat-card compact">
          <div class="label">Compactions</div>
          <div class="value" style="color: ${s.compaction_count > 0 ? 'var(--orange)' : 'var(--text)'}">${s.compaction_count}</div>
        </div>
        <div class="stat-card compact">
          <div class="label">Tool Calls</div>
          <div class="value">${s.tool_call_count}</div>
        </div>
        <div class="stat-card compact">
          <div class="label">Risk Score</div>
          <div class="value" style="color: ${riskColor(score)}">${score.toFixed(2)}</div>
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
          <${Timeline} sessionId=${id} sessionStart=${s.started_at} />
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
