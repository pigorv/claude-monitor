import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { html } from "htm/preact";
import { fetchSessions, fetchApi } from "../api/client";
import { Sparkline } from "../components/Sparkline";
import type { SessionSummary, SessionListResponse } from "../../../src/shared/types";
import "../styles/session-list.css";

// ── Formatting helpers ──────────────────────────────────────────────

function formatDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${secs}s`;
}

function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null || usd === 0) return "";
  return `~$${usd.toFixed(2)}`;
}

function modelClass(model: string | null | undefined): string {
  if (!model) return "";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return "";
}

function modelLabel(model: string | null | undefined): string {
  if (!model) return "—";
  const m = model.toLowerCase();
  if (m.includes("opus")) return "Opus";
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("haiku")) return "Haiku";
  return model;
}

function isLargeContext(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // Opus 4.6+ supports 1M context window
  return m.includes("opus");
}

function projectColor(name: string): string {
  const colors = [
    "var(--purple)", "var(--accent)", "var(--teal)",
    "var(--orange)", "var(--green)", "var(--yellow)",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function compactionClass(count: number): string {
  if (count === 0) return "ok";
  if (count <= 2) return "warn";
  return "danger";
}

// ── Sort / filter types ─────────────────────────────────────────────

type SortColumn = "started_at" | "project_name" | "model" | "duration_ms" | "compaction_count" | "subagent_count";
type SortOrder = "asc" | "desc";

const SORT_COLUMN_TO_API: Record<SortColumn, string> = {
  started_at: "started_at",
  project_name: "project_name",
  model: "model",
  duration_ms: "duration_ms",
  compaction_count: "compaction_count",
  subagent_count: "subagent_count",
};

const PAGE_SIZE = 25;

type ChipFilter = "all" | "opus" | "sonnet" | "haiku";

// ── Stats interface ─────────────────────────────────────────────────

interface StatsData {
  session_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_risk_score: number;
  avg_duration_ms: number;
  total_compactions: number;
  total_subagents: number;
  sessions_with_compactions: number;
  total_cost_estimate_usd?: number;
  oldest_session?: string;
  newest_session?: string;
  high_risk_sessions?: number;
  sessions_today?: number;
}

// ── Component ───────────────────────────────────────────────────────

export function SessionList() {
  // Filter state
  const [chipFilter, setChipFilter] = useState<ChipFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Sort state
  const [sortCol, setSortCol] = useState<SortColumn>("started_at");
  const [sortOrder, setSortOrder] = useState<SortOrder>("desc");

  // Pagination
  const [offset, setOffset] = useState(0);

  // Data
  const [data, setData] = useState<SessionListResponse | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce search
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = useCallback((e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    setSearchQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedQuery(val), 300);
  }, []);

  // Load stats
  useEffect(() => {
    fetchApi<StatsData>("/api/stats").then(setStats).catch(() => {});
  }, []);

  // Reset offset on filter changes
  useEffect(() => {
    setOffset(0);
  }, [chipFilter, debouncedQuery]);

  // Build filter params from chip
  function buildParams(): Record<string, string | number | undefined> {
    const params: Record<string, string | number | undefined> = {
      sort: SORT_COLUMN_TO_API[sortCol],
      order: sortOrder,
      limit: PAGE_SIZE,
      offset,
    };

    if (debouncedQuery) params.q = debouncedQuery;

    switch (chipFilter) {
      case "opus":
        params.model = "opus";
        break;
      case "sonnet":
        params.model = "sonnet";
        break;
      case "haiku":
        params.model = "haiku";
        break;
    }

    return params;
  }

  // Fetch sessions
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSessions(buildParams())
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

    return () => { cancelled = true; };
  }, [chipFilter, debouncedQuery, sortCol, sortOrder, offset]);

  function toggleSort(col: SortColumn) {
    if (sortCol === col) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortCol(col);
      setSortOrder(col === "started_at" ? "desc" : "asc");
    }
  }

  function sortClass(col: SortColumn): string {
    if (sortCol !== col) return "sortable";
    return `sortable sort-${sortOrder}`;
  }

  function navigateToSession(id: string) {
    location.hash = `#/session/${id}`;
  }

  // Pagination info
  const total = data?.total ?? 0;
  const rangeStart = total > 0 ? offset + 1 : 0;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  // Stats calculations
  const totalTokens = stats ? stats.total_input_tokens + stats.total_output_tokens : 0;

  // Count active sessions from loaded data
  const activeSessions = data ? data.sessions.filter((s: SessionSummary) => s.status === "running").length : 0;

  // Unique projects count
  const uniqueProjects = data ? new Set(data.sessions.map((s: SessionSummary) => s.project_name)).size : 0;

  return html`
    <div class="page">
      <h1>Sessions</h1>
      <div class="page-sub">
        ${stats ? `Monitoring ${stats.session_count} sessions across ${uniqueProjects} projects` : "Loading..."}
      </div>

      <!-- Stats bar -->
      <div class="stats stats-4">
        <div class="stat-card">
          <div class="label">Total Sessions</div>
          <div class="value">${stats?.session_count ?? "—"}</div>
          <div class="detail">${activeSessions > 0 ? `${activeSessions} active` : `${stats?.sessions_today ?? 0} today`}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Tokens</div>
          <div class="value">${formatTokens(totalTokens)}</div>
          <div class="detail">${stats?.total_cost_estimate_usd ? formatCost(stats.total_cost_estimate_usd) + " est." : ""}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Compactions</div>
          <div class="value orange">${stats?.total_compactions ?? "—"}</div>
        </div>
        <div class="stat-card">
          <div class="label">Avg Duration</div>
          <div class="value">${stats ? formatDuration(stats.avg_duration_ms) : "—"}</div>
        </div>
      </div>

      <!-- Controls: search + chip filters -->
      <div class="controls">
        <input
          class="search-input"
          placeholder="Search sessions..."
          value=${searchQuery}
          onInput=${handleSearch}
        />
        <div class="filter-chips">
          ${(["all", "opus", "sonnet", "haiku"] as const).map(
            (f) => html`
              <div
                class=${`chip ${chipFilter === f ? "active" : ""}`}
                onClick=${() => setChipFilter(f as ChipFilter)}
              >
                ${f.charAt(0).toUpperCase() + f.slice(1)}
              </div>
            `
          )}
        </div>
        <span class="sort-label">Sort: Latest first</span>
      </div>

      ${loading && html`<div class="status-text">Loading sessions...</div>`}
      ${error && html`<div class="error-text">${error}</div>`}
      ${!loading && !error && total === 0 && html`<div class="status-text">No sessions found.</div>`}

      ${!loading && !error && total > 0 && html`
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class=${sortClass("project_name")} onClick=${() => toggleSort("project_name")}>Session</th>
                <th class=${sortClass("model")} onClick=${() => toggleSort("model")}>Model</th>
                <th class=${sortClass("duration_ms")} onClick=${() => toggleSort("duration_ms")}>Duration</th>
                <th class=${sortClass("compaction_count")} onClick=${() => toggleSort("compaction_count")}>Compactions</th>
                <th class=${sortClass("subagent_count")} onClick=${() => toggleSort("subagent_count")}>Agents</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${data!.sessions.map(
                (s: SessionSummary) => html`
                  <tr onClick=${() => navigateToSession(s.id)}>
                    <td>
                      <div class="proj-name">
                        <div class="proj-dot" style=${`background:${projectColor(s.project_name || "default")}`}></div>
                        ${s.project_name || "—"}
                        ${s.status === "running" ? html`<span class="active-dot" title="Active session"></span>` : null}
                      </div>
                      <div class="proj-summary">${s.summary || "—"}</div>
                    </td>
                    <td>
                      <span class="model-pill ${modelClass(s.model)}">
                        ${modelLabel(s.model)}
                        ${isLargeContext(s.model) ? html` <span class="ctx-label">1M</span>` : null}
                      </span>
                    </td>
                    <td class="mono">${formatDuration(s.duration_ms)}</td>
                    <td>
                      <span class="cc ${compactionClass(s.compaction_count)}">${s.compaction_count}</span>
                    </td>
                    <td>
                      ${s.subagent_count > 0
                        ? html`<span class="ag">${s.subagent_count}</span>`
                        : html`<span class="ag none">0</span>`
                      }
                    </td>
                    <td class="spark">
                      <${Sparkline} data=${(s as any).mini_timeline || []} />
                    </td>
                  </tr>
                `
              )}
            </tbody>
          </table>
          <div class="pagination">
            <span>Showing ${rangeStart}–${rangeEnd} of ${total} sessions</span>
            <div class="page-btns">
              <button disabled=${!hasPrev} onClick=${() => setOffset(Math.max(0, offset - PAGE_SIZE))}>← Previous</button>
              <button disabled=${!hasNext} onClick=${() => setOffset(offset + PAGE_SIZE)}>Next →</button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}
