import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { html } from "htm/preact";
import { fetchSessions, fetchApi, fetchProjects } from "../api/client";
import { SessionHealthStrip } from "../components/SessionHealthStrip";
import { BackToTop } from "../components/BackToTop";
import { usePersistentState } from "../hooks/usePersistentState";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { updateParams } from "../lib/url-state";
import { migrateProjectFilterKey } from "../lib/migrate-project-filter";
import type { SessionSummary, ProjectInfo, Invocation } from "../../../src/shared/types";
import "../styles/pills.css";
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

// ── Pills row for skills ────────────────────────────────────────────

const PILLS_VISIBLE_LIMIT = 3;

function SessionPills({ invocations }: { invocations: Invocation[] }) {
  const [expanded, setExpanded] = useState(false);
  const skills = invocations.filter((inv) => inv.type === "skill");
  if (skills.length === 0) return null;
  const overflow = skills.length > PILLS_VISIBLE_LIMIT;
  const visible = expanded ? skills : skills.slice(0, PILLS_VISIBLE_LIMIT);
  const hidden = skills.length - visible.length;
  return html`
    <div class="session-pills" onClick=${(e: Event) => e.stopPropagation()}>
      ${visible.map((inv) => html`<span class="skill-badge">${inv.name}</span>`)}
      ${overflow && html`
        <span class="pill-more"
              onClick=${() => setExpanded((v) => !v)}
              title=${expanded ? "Show fewer" : `Show all ${skills.length} skills`}>
          ${expanded ? "Show less" : `+${hidden} more`}
        </span>
      `}
    </div>
  `;
}

// ── Sort / filter types ─────────────────────────────────────────────

type SortColumn = "started_at" | "project_name" | "model" | "duration_ms" | "subagent_count";
type SortOrder = "asc" | "desc";

const SORT_COLUMN_TO_API: Record<SortColumn, string> = {
  started_at: "started_at",
  project_name: "project_name",
  model: "model",
  duration_ms: "duration_ms",
  subagent_count: "subagent_count",
};

const VALID_SORT_COLS: SortColumn[] = [
  "started_at", "project_name", "model", "duration_ms", "compaction_count", "subagent_count",
];
const VALID_CHIPS: ChipFilter[] = ["all", "opus", "sonnet", "haiku"];

const PAGE_SIZE = 25;
const MAX_VISIBLE_PROJECTS = 5;

// localStorage keys (Tier 2 cross-session preferences)
const LS_CHIP = "cm.sessionList.chipFilter";
const LS_PROJECT = "cm.sessionList.project";
const LS_SORT = "cm.sessionList.sort";
const LS_PROJECTS_EXPANDED = "cm.sessionList.projectsExpanded";

// One-shot migration from the previous `cm:projectFilter` key. Runs once at
// module load so usePersistentState sees the new value on first mount.
migrateProjectFilterKey();

type ChipFilter = "all" | "opus" | "sonnet" | "haiku";

interface SortPref {
  col: SortColumn;
  order: SortOrder;
}
const DEFAULT_SORT: SortPref = { col: "started_at", order: "desc" };

// ── Stats interface ─────────────────────────────────────────────────

interface StatsData {
  session_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_duration_ms: number;
  total_compactions: number;
  total_subagents: number;
  sessions_with_compactions: number;
  total_cost_estimate_usd?: number;
  oldest_session?: string;
  newest_session?: string;
  sessions_today?: number;
}

// ── Component ───────────────────────────────────────────────────────

export function SessionList({ params }: { params: URLSearchParams }) {
  // Tier 2 preferences (localStorage)
  const [chipPref, setChipPref] = usePersistentState<ChipFilter>(LS_CHIP, "all");
  const [projectPref, setProjectPref] = usePersistentState<string | null>(LS_PROJECT, null);
  const [sortPref, setSortPref] = usePersistentState<SortPref>(LS_SORT, DEFAULT_SORT);
  const [projectsExpanded, setProjectsExpanded] = usePersistentState<boolean>(LS_PROJECTS_EXPANDED, false);

  // Effective values: URL (Tier 1) overrides localStorage; otherwise pref wins.
  const urlModel = params.get("model");
  const urlProject = params.get("project");
  const urlSort = params.get("sort");
  const urlOrder = params.get("order");
  const urlQ = params.get("q") ?? "";

  const chipFilter: ChipFilter = (urlModel && VALID_CHIPS.includes(urlModel as ChipFilter))
    ? (urlModel as ChipFilter)
    : chipPref;
  const selectedProject: string | null = urlProject ?? projectPref;
  const sortCol: SortColumn = (urlSort && VALID_SORT_COLS.includes(urlSort as SortColumn))
    ? (urlSort as SortColumn)
    : sortPref.col;
  const sortOrder: SortOrder = (urlOrder === "asc" || urlOrder === "desc")
    ? urlOrder
    : sortPref.order;
  const debouncedQuery = urlQ;

  // Local mirror for the search input — keeps typing smooth while URL writes
  // are debounced. Re-syncs when the URL is changed from elsewhere (Reset).
  const [searchQuery, setSearchQuery] = useState(urlQ);
  useEffect(() => { setSearchQuery(urlQ); }, [urlQ]);

  // Project list (server data)
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  // Infinite scroll — `offset` is internal; the user only sees a sentinel
  // that loads the next page when scrolled into view.
  const [offset, setOffset] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [total, setTotal] = useState(0);

  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [endOfList, setEndOfList] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Debounced URL write for search
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearch = useCallback((e: Event) => {
    const val = (e.target as HTMLInputElement).value;
    setSearchQuery(val);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      updateParams({ q: val || null }, "replace");
    }, 300);
  }, []);

  function setChipFilter(next: ChipFilter) {
    setChipPref(next);
    updateParams({ model: next === "all" ? null : next }, "replace");
  }

  function selectProject(path: string | null) {
    setProjectPref(path);
    updateParams({ project: path }, "replace");
  }

  function applySort(col: SortColumn, order: SortOrder) {
    setSortPref({ col, order });
    updateParams({ sort: col, order }, "replace");
  }

  function resetFilters() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSearchQuery("");
    setChipPref("all");
    setProjectPref(null);
    setSortPref(DEFAULT_SORT);
    updateParams(
      { model: null, q: null, project: null, sort: null, order: null },
      "replace",
    );
  }

  // Load stats
  useEffect(() => {
    fetchApi<StatsData>("/api/stats").then(setStats).catch(() => {});
  }, []);

  // Load projects, then prune a stale project preference if it points at
  // something that no longer exists.
  useEffect(() => {
    fetchProjects()
      .then(({ projects: list }) => {
        setProjects(list);
        if (selectedProject && !list.some((p) => p.project_path === selectedProject)) {
          // Clear both URL and localStorage so the empty state takes over.
          setProjectPref(null);
          if (urlProject) updateParams({ project: null }, "replace");
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset offset and accumulated sessions on filter/sort changes
  useEffect(() => {
    setOffset(0);
    setSessions([]);
    setTotal(0);
    setEndOfList(false);
    setLoadError(null);
  }, [chipFilter, debouncedQuery, selectedProject, sortCol, sortOrder]);

  // Build filter params from chip
  function buildParams(): Record<string, string | number | undefined> {
    const queryParams: Record<string, string | number | undefined> = {
      sort: SORT_COLUMN_TO_API[sortCol],
      order: sortOrder,
      limit: PAGE_SIZE,
      offset,
    };

    if (debouncedQuery) queryParams.q = debouncedQuery;
    if (selectedProject) queryParams.project_path = selectedProject;

    switch (chipFilter) {
      case "opus":
        queryParams.model = "opus";
        break;
      case "sonnet":
        queryParams.model = "sonnet";
        break;
      case "haiku":
        queryParams.model = "haiku";
        break;
    }

    return queryParams;
  }

  // Fetch sessions — appends when offset > 0 (next page), replaces on offset 0.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    fetchSessions(buildParams())
      .then((res) => {
        if (cancelled) return;
        setTotal(res.total);
        if (offset === 0) {
          setSessions(res.sessions);
        } else {
          setSessions((prev) => {
            const seen = new Set(prev.map((s) => s.id));
            const fresh = res.sessions.filter((s) => !seen.has(s.id));
            return prev.concat(fresh);
          });
        }
        if (res.sessions.length === 0) setEndOfList(true);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [chipFilter, debouncedQuery, selectedProject, sortCol, sortOrder, offset, retryNonce]);

  const hasMore = !endOfList && sessions.length < total;
  const loadMore = useCallback(() => {
    if (loading || loadError || !hasMore) return;
    setOffset((prev) => prev + PAGE_SIZE);
  }, [loading, loadError, hasMore]);

  const retry = useCallback(() => {
    if (loading || !hasMore) return;
    setLoadError(null);
    setRetryNonce((n) => n + 1);
  }, [loading, hasMore]);

  useInfiniteScroll(sentinelRef, { hasMore, loading, onLoadMore: loadMore });

  function toggleSort(col: SortColumn) {
    if (sortCol === col) {
      applySort(col, sortOrder === "asc" ? "desc" : "asc");
    } else {
      applySort(col, col === "started_at" ? "desc" : "asc");
    }
  }

  function sortClass(col: SortColumn): string {
    if (sortCol !== col) return "sortable";
    return `sortable sort-${sortOrder}`;
  }

  function navigateToSession(id: string) {
    location.hash = `#/session/${id}`;
  }

  // Stats calculations
  const totalTokens = stats ? stats.total_input_tokens + stats.total_output_tokens : 0;

  // Count active sessions from loaded data
  const activeSessions = sessions.filter((s: SessionSummary) => s.status === "running").length;

  // Unique projects count — prefer the full list from /api/projects over the current page
  const uniqueProjects = projects.length > 0
    ? projects.length
    : new Set(sessions.map((s: SessionSummary) => s.project_name)).size;

  // Visible project chips (with overflow)
  const visibleProjects = projectsExpanded ? projects : projects.slice(0, MAX_VISIBLE_PROJECTS);
  const hasOverflow = projects.length > MAX_VISIBLE_PROJECTS;

  // Show Clear filters whenever the effective view differs from factory
  // defaults — URL params and localStorage prefs both count as "active".
  const hasActiveFilters = chipFilter !== "all"
    || searchQuery !== ""
    || selectedProject != null
    || sortCol !== DEFAULT_SORT.col
    || sortOrder !== DEFAULT_SORT.order;

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
        ${hasActiveFilters && html`
          <button class="reset-filters" onClick=${resetFilters} title="Clear filters and saved defaults">
            <span class="reset-x" aria-hidden="true">×</span>
            Clear filters
          </button>
        `}
        <span class="sort-label">Sort: Latest first</span>

        ${projects.length > 1 && html`
          <div class="project-chips">
            <div
              class=${`chip ${!selectedProject ? "active" : ""}`}
              onClick=${() => selectProject(null)}
            >
              All Projects
            </div>
            ${visibleProjects.map(
              (p: ProjectInfo) => html`
                <div
                  class=${`chip project-chip ${selectedProject === p.project_path ? "active" : ""}`}
                  title=${p.project_path}
                  onClick=${() => selectProject(p.project_path)}
                >
                  <span class="chip-dot" style=${`background:${projectColor(p.project_name || "default")}`}></span>
                  ${(p.project_name || "unknown").length > 20 ? (p.project_name || "unknown").slice(0, 20) + "..." : (p.project_name || "unknown")}
                  <span class="chip-count">${p.session_count}</span>
                </div>
              `
            )}
            ${hasOverflow && html`
              <div
                class="chip overflow-chip"
                onClick=${() => setProjectsExpanded(!projectsExpanded)}
              >
                ${projectsExpanded ? "Show less" : `+${projects.length - MAX_VISIBLE_PROJECTS} more`}
              </div>
            `}
          </div>
        `}
      </div>

      ${loading && sessions.length === 0 && html`<div class="status-text">Loading sessions...</div>`}
      ${loadError && sessions.length === 0 && html`<div class="error-text">${loadError}</div>`}
      ${!loading && !loadError && total === 0 && html`<div class="status-text">No sessions found.</div>`}

      ${sessions.length > 0 && html`
        <div class="table-wrap sticky-head">
          <table>
            <thead>
              <tr>
                <th class=${sortClass("project_name")} onClick=${() => toggleSort("project_name")}>Session</th>
                <th title="Skills invoked in this session">Skills</th>
                <th class=${sortClass("model")} onClick=${() => toggleSort("model")}>Model</th>
                <th class=${sortClass("duration_ms")} onClick=${() => toggleSort("duration_ms")}>Duration</th>
                <th class="${sortClass("subagent_count")} agents-cell" onClick=${() => toggleSort("subagent_count")}>Agents</th>
                <th
                  title="Main session only (excludes subagents). Context % of the model window, peak tokens scaled to a 1M reference, and compaction count (one filled dot per compaction, capped at three)."
                  style="cursor: help;"
                >
                  Health
                  <span class="th-hint" aria-hidden="true">ⓘ</span>
                </th>
              </tr>
            </thead>
            <tbody>
              ${sessions.map(
                (s: SessionSummary) => html`
                  <tr onClick=${() => navigateToSession(s.id)}>
                    <td>
                      <div class="proj-name">
                        <div class="proj-dot" style=${`background:${projectColor(s.project_name || "default")}`}></div>
                        ${s.project_name || "—"}
                        ${s.status === "running" ? html`<span class="active-dot" title="Active session"></span>` : null}
                      </div>
                      <div class="proj-summary">
                        ${s.started_with && html`<span class="cmd-pill">${s.started_with.name}</span>`}
                        ${(() => {
                          const summary = (s.summary ?? "").trim();
                          const startedName = s.started_with?.name;
                          // Hide the summary when it duplicates the command/skill that started
                          // the session (e.g. row labelled both "/clear" and "/clear").
                          if (startedName && summary === startedName) return null;
                          if (summary) return html`<span class="proj-summary-text">${summary}</span>`;
                          if (!s.started_with) return html`<span class="proj-summary-text">—</span>`;
                          return null;
                        })()}
                      </div>
                    </td>
                    <td class="skills-cell">
                      ${s.invocations && s.invocations.some((i) => i.type === "skill")
                        ? html`<${SessionPills} invocations=${s.invocations} />`
                        : html`<span class="muted">—</span>`}
                    </td>
                    <td>
                      ${(s.models_used && s.models_used.length > 1)
                        ? html`
                          <span class="model-pill ${modelClass(s.models_used[s.models_used.length - 1])}">
                            ${s.models_used.map((m: string, i: number) => html`
                              ${i > 0 ? html`<span class="model-switch">→</span>` : null}${modelLabel(m)}
                            `)}
                            ${isLargeContext(s.models_used[s.models_used.length - 1]) ? html` <span class="ctx-label">1M</span>` : null}
                          </span>
                        `
                        : html`
                          <span class="model-pill ${modelClass(s.model)}">
                            ${modelLabel(s.model)}
                            ${isLargeContext(s.model) ? html` <span class="ctx-label">1M</span>` : null}
                          </span>
                        `
                      }
                    </td>
                    <td class="mono">${formatDuration(s.duration_ms)}</td>
                    <td class="agents-cell">
                      ${s.subagent_count > 0
                        ? html`<span class="ag">${s.subagent_count}</span>`
                        : html`<span class="ag none">0</span>`
                      }
                    </td>
                    <td class="health">
                      <${SessionHealthStrip}
                        contextPct=${s.peak_context_pct ?? 0}
                        peakTokens=${s.peak_tokens ?? 0}
                        compactionCount=${s.compaction_count ?? 0}
                      />
                    </td>
                  </tr>
                `
              )}
            </tbody>
          </table>
          <div class="infinite-sentinel" ref=${sentinelRef}>
            ${loading && html`<span class="status-text">Loading more…</span>`}
            ${loadError && !loading && html`
              <span class="error-text">${loadError}</span>
              <button class="retry-btn" onClick=${retry}>Retry</button>
            `}
            ${!loading && !loadError && !hasMore && html`
              <span class="status-text">All ${total} sessions loaded</span>
            `}
            ${!loading && !loadError && hasMore && html`
              <span class="status-text">${sessions.length} / ${total} loaded</span>
            `}
          </div>
        </div>
      `}
      <${BackToTop} />
    </div>
  `;
}
