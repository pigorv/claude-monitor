import { useState, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { fetchSession, openTerminal, getPlatform, type TerminalPreference } from "../api/client";
import { Timeline } from "../components/Timeline";
import { TokenChart } from "../components/TokenChart";
import { AgentTree } from "../components/AgentTree";
import { BackToTop } from "../components/BackToTop";
import { CopyButton } from "../components/CopyButton";
import { ExportButton } from "../components/ExportButton";
import { TokenBudgetSummary } from "../components/TokenBudgetSummary";
import { TokenBudgetPanel } from "../components/TokenBudgetPanel";
import { updateParams } from "../lib/url-state";
import type { SessionDetailResponse } from "../../../src/shared/types";
import { modelClass, modelLabel, modelVersion, isOneMSonnet } from "../lib/model-meta";
import "../styles/pills.css";
import "../styles/session-detail.css";

// One-shot cleanup of a now-unused preference. Sentinel ensures we don't
// hit localStorage on every page load forever.
(function clearLegacySessionDetailTab() {
  try {
    if (localStorage.getItem("cm.sessionDetail.tabCleared") === "1") return;
    localStorage.removeItem("cm.sessionDetail.tab");
    localStorage.setItem("cm.sessionDetail.tabCleared", "1");
  } catch {}
})();

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

type Tab = "timeline" | "context" | "agents";
const VALID_TABS: readonly Tab[] = ["timeline", "context", "agents"];

function isTab(v: string | null | undefined): v is Tab {
  return v != null && (VALID_TABS as readonly string[]).includes(v);
}

function OpenInTerminalButton({ sessionId, projectPath }: { sessionId: string; projectPath?: string }) {
  const [state, setState] = useState<"idle" | "launching" | "opened">("idle");
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);

  useEffect(() => {
    getPlatform().then(setPlatform);
  }, []);

  const platformSupported = platform == null || platform === "darwin" || platform === "win32";
  const disabled = !projectPath || state === "launching" || !platformSupported;

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
    : !platformSupported
    ? "Open in Terminal is not supported on this platform yet"
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

export function SessionDetail({ id, params }: { id: string; params: URLSearchParams }) {
  const [data, setData] = useState<SessionDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tab is URL-only — opening a session always lands on Timeline unless the
  // URL explicitly carries ?tab= (shareable links and back/forward).
  const urlTab = params.get("tab");
  const tab: Tab = isTab(urlTab) ? urlTab : "timeline";

  function selectTab(next: Tab) {
    updateParams({ tab: next }, "push");
  }

  // Token-budget panel expand state is URL-only (?budget=open) so it survives
  // tab switches, reload, sharing, and back/forward. It's view-state, not
  // navigation, so toggling uses "replace" to avoid back-button noise.
  const budgetExpanded = params.get("budget") === "open";
  function toggleBudget() {
    updateParams({ budget: budgetExpanded ? null : "open" }, "replace");
  }

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
  const modelsUsed: string[] = s.models_used ? JSON.parse(s.models_used) : [];

  return html`
    <div class="page session-detail">
      <div class="session-header">
        <div class="breadcrumb">
          <a href="#/">Sessions</a>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="opacity:0.4"><path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span style="color:var(--color-text-tertiary)">${s.project_name || 'Unknown'}</span>
        </div>
        <h1 class="session-title">${s.summary || s.project_name || 'Session'}</h1>
        <div class="session-subtitle">
          ${(modelsUsed.length > 1)
            ? html`
              <span class="model-pill ${modelClass(modelsUsed[modelsUsed.length - 1])}">
                ${modelsUsed.map((m: string, i: number) => html`
                  ${i > 0 ? html`<span class="model-switch">→</span>` : null}${modelLabel(m, "Unknown")}${modelVersion(m) ? html`<span class="pill-ver">${modelVersion(m)}</span>` : null}
                `)}
                ${isOneMSonnet(modelsUsed[modelsUsed.length - 1]) ? html` <span class="ctx-label">1M</span>` : null}
              </span>
            `
            : html`
              <span class="model-pill ${modelClass(s.model)}">
                ${modelLabel(s.model, "Unknown")}${modelVersion(s.model) ? html`<span class="pill-ver">${modelVersion(s.model)}</span>` : null}
                ${isOneMSonnet(s.model) ? html` <span class="ctx-label">1M</span>` : null}
              </span>
            `
          }
          <span class="sep">·</span>
          <span class="meta-item">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="color:var(--color-text-tertiary)"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 3.5V6L7.5 7.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            ${formatDuration(s.duration_ms)}
          </span>
          <span class="sep">·</span>
          ${s.tool_call_count} tool calls
          <span class="sep">·</span>
          <span style="color:var(--color-text-tertiary)">ended ${formatEndTime(s.ended_at)}</span>
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
          <${ExportButton} sessionId=${s.id} />
        </div>
      </div>

      <${TokenBudgetSummary} budget=${data.token_budget} model=${s.model} expanded=${budgetExpanded} onToggle=${toggleBudget} />
      ${budgetExpanded && html`<${TokenBudgetPanel} budget=${data.token_budget} />`}

      <div class="tab-bar">
        <button
          class=${tab === "timeline" ? "tab active" : "tab"}
          onClick=${() => selectTab("timeline")}
        >
          Timeline${data.event_count != null ? html`<span class="count">${data.event_count}</span>` : ''}
        </button>
        <button
          class=${tab === "context" ? "tab active" : "tab"}
          onClick=${() => selectTab("context")}
        >
          Context
        </button>
        <button
          class=${tab === "agents" ? "tab active" : "tab"}
          onClick=${() => selectTab("agents")}
        >
          Agents${s.subagent_count > 0 ? html`<span class="count">${s.subagent_count}</span>` : ''}
        </button>
      </div>

      <div class="tab-content">
        ${tab === "timeline" && html`
          <${Timeline} sessionId=${id} sessionStart=${s.started_at} agents=${data.agents} params=${params} />
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
          <${AgentTree} agents=${data.agents} sessionStart=${s.started_at} agentEfficiency=${data.agent_efficiency} params=${params} />
        `}
      </div>
      <${BackToTop} />
    </div>
  `;
}
