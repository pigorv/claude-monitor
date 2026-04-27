import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { fetchSession, openTerminal, type TerminalPreference } from "../api/client";
import { Timeline } from "../components/Timeline";
import { TokenChart } from "../components/TokenChart";
import { AgentTree } from "../components/AgentTree";
import type { SessionDetailResponse } from "../../../src/shared/types";
import { resolveThresholds } from "../lib/chart-config";
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

function modelClass(model: string | null): string {
  if (!model) return "";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "";
}

function isLargeContext(model: string | null): boolean {
  if (!model) return false;
  return model.toLowerCase().includes("opus");
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

function peakAccentColor(pct: number): string {
  if (pct >= 80) return "var(--red)";
  if (pct >= 60) return "var(--orange)";
  if (pct >= 40) return "var(--yellow)";
  return "var(--green)";
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

function OpenInTerminalButton({ sessionId, projectPath }: { sessionId: string; projectPath?: string }) {
  const [state, setState] = useState<"idle" | "launching" | "opened">("idle");
  const [error, setError] = useState<string | null>(null);

  const disabled = !projectPath || state === "launching";

  const handleClick = async () => {
    if (disabled) return;
    setError(null);
    setState("launching");
    const pref = (localStorage.getItem("claude-monitor-terminal") as TerminalPreference | null) || "auto";
    try {
      await openTerminal(sessionId, pref);
      setState("opened");
      setTimeout(() => setState("idle"), 1500);
    } catch (e: any) {
      setError(e?.message || "Failed to open terminal");
      setState("idle");
    }
  };

  const title = !projectPath
    ? "No project directory recorded for this session"
    : error
    ? error
    : "Open in Terminal";

  return html`
    <button
      class="copy-btn"
      onClick=${handleClick}
      disabled=${disabled}
      title=${title}
    >
      ${state === "launching" ? "Launching…" : state === "opened" ? "Opened ✓" : html`
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="flex-shrink:0"><rect x="1" y="2" width="10" height="8" rx="1.2" stroke="currentColor" stroke-width="1.1"/><path d="M3 5L5 6.5L3 8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 8H8.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>
        Open in Terminal
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
  const modelsUsed: string[] = s.models_used ? JSON.parse(s.models_used) : [];

  // Context tab stat card data
  const headerThresholds = resolveThresholds(s.model);
  const peakContextPct = s.peak_context_pct ?? 0;
  const fileCount = data.file_activity?.files.length ?? 0;
  const rereadFiles = data.file_activity?.files.filter(f => f.read_count >= 2) ?? [];
  const totalRereads = rereadFiles.reduce((sum, f) => sum + (f.read_count - 1), 0);

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
          ${(modelsUsed.length > 1)
            ? html`
              <span class="model-pill ${modelClass(modelsUsed[modelsUsed.length - 1])}">
                ${modelsUsed.map((m: string, i: number) => html`
                  ${i > 0 ? html`<span class="model-switch">→</span>` : null}${modelLabel(m)}
                `)}
                ${isLargeContext(modelsUsed[modelsUsed.length - 1]) ? html` <span class="ctx-label">1M</span>` : null}
              </span>
            `
            : html`
              <span class="model-pill ${modelClass(s.model)}">
                ${modelLabel(s.model)}
                ${isLargeContext(s.model) ? html` <span class="ctx-label">1M</span>` : null}
              </span>
            `
          }
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
          <${OpenInTerminalButton} sessionId=${s.id} projectPath=${s.project_path} />
        </div>
      </div>

      <div class="context-stats-row">
        <div class="stat-card">
          <div class="stat-card-accent" style="background: ${peakAccentColor(peakContextPct)}"></div>
          <div class="label">Peak Context</div>
          <div class="value" style="color: ${peakAccentColor(peakContextPct)}">${peakContextPct.toFixed(0)}%</div>
          <div class="detail">danger threshold 70%</div>
          <div class="progress">
            <div class="fill" style="width: ${Math.min(peakContextPct, 100)}%; background: ${peakAccentColor(peakContextPct)}"></div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-card-accent" style="background: var(--accent)"></div>
          <div class="label">Peak Tokens</div>
          <div class="value">${data.peak_parent_tokens != null ? formatTokens(data.peak_parent_tokens) : "\u2014"}</div>
          <div class="detail">of ${formatTokens(headerThresholds.maxTokens)} window \u00b7 parent only</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-accent" style="background: ${s.compaction_count > 0 ? 'var(--orange)' : 'var(--border)'}"></div>
          <div class="label">Compactions</div>
          <div class="value" style="color: ${s.compaction_count > 0 ? 'var(--orange)' : ''}">${s.compaction_count}</div>
          <div class="detail">${s.compaction_count > 0 ? "auto-triggered" : "none"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-accent" style="background: var(--accent)"></div>
          <div class="label">Files Loaded</div>
          <div class="value">${fileCount}</div>
          <div class="detail">${totalRereads > 0 ? `${totalRereads} re-reads across ${rereadFiles.length} files` : "no re-reads"}</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-accent" style="background: ${s.subagent_count > 0 ? 'var(--teal)' : 'var(--border)'}"></div>
          <div class="label">Agents</div>
          <div class="value">${s.subagent_count}</div>
          <div class="detail">${s.subagent_count > 0 ? "sub-agents" : "none"}</div>
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
          <${TokenChart}
            timeline=${data.token_timeline}
            model=${s.model}
            compactionDetails=${data.compaction_details}
            session=${s}
            fileActivity=${data.file_activity}
            eventAnnotations=${data.event_annotations}
          />
        `}
        ${tab === "agents" && html`
          <${AgentTree} agents=${data.agents} sessionStart=${s.started_at} agentEfficiency=${data.agent_efficiency} />
        `}
      </div>
    </div>
  `;
}
