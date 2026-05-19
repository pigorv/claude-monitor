import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import { html } from "htm/preact";
import { fetchSessions, fetchApi, fetchProjects } from "../api/client";
import { BackToTop } from "../components/BackToTop";
import { FilterBar } from "../components/FilterBar";
import { usePersistentState } from "../hooks/usePersistentState";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { updateParams } from "../lib/url-state";
import { migrateProjectFilterKey } from "../lib/migrate-project-filter";
import { projectColor, formatTokenCount } from "../lib/format";
import { resolveThresholds } from "../lib/chart-config";
import type { SessionSummary, ProjectInfo } from "../../../src/shared/types";
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

// Compact token glyph: "12K" / "142K"; raw for tiny counts, "0" for none.
function compactTokens(n: number | null | undefined): string {
  return formatTokenCount(n) ?? String(n ?? 0);
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const diffMin = Math.floor((Date.now() - then) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(iso).toLocaleDateString();
}

function formatClock(d: Date): string {
  if (isNaN(d.getTime())) return "";
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

// TODAY / YESTERDAY / THIS WEEK / ISO-date bucket from a start timestamp.
function dateBucket(iso: string): { key: string; label: string } {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { key: "unknown", label: "UNKNOWN" };
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (diffDays <= 0) return { key: "today", label: "TODAY" };
  if (diffDays === 1) return { key: "yesterday", label: "YESTERDAY" };
  if (diffDays < 7) return { key: "week", label: "THIS WEEK" };
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { key: ymd, label: ymd };
}

// Peak-context color class — same model thresholds the Context chart uses.
function ctxClass(pct: number, model: string | null | undefined): string {
  const t = resolveThresholds(model);
  if (pct >= t.dangerPct) return "tel-ctx tel-red";
  if (pct >= t.warningPct) return "tel-ctx tel-amber";
  return "tel-ctx tel-green";
}

// Cache hit ratio: cache_read / (cache_read + cache_write + input). Null when
// there is no token activity to divide by.
function cacheHitPct(s: SessionSummary): number | null {
  const denom =
    s.total_cache_read_tokens + s.total_cache_write_tokens + s.total_input_tokens;
  if (denom <= 0) return null;
  return (s.total_cache_read_tokens / denom) * 100;
}

// Drop a leading started-with name (and any joining punctuation) from the
// summary so it isn't duplicated next to the pill.
function stripPrefix(summary: string, prefix: string | undefined): string {
  if (!prefix || !summary) return summary;
  if (summary === prefix) return "";
  if (summary.startsWith(prefix)) {
    return summary.slice(prefix.length).replace(/^[\s—–\-:·|]+/, "").trim();
  }
  return summary;
}

// Turn / sub-agent / tool counts as a single muted string. Skills render as
// pills separately so they keep their badge styling.
function buildMeta(s: SessionSummary): string {
  const parts: string[] = [];
  if (s.turn_count > 0) parts.push(`${s.turn_count} turn${s.turn_count === 1 ? "" : "s"}`);
  if (s.subagent_count > 0)
    parts.push(`${s.subagent_count} sub-agent${s.subagent_count === 1 ? "" : "s"}`);
  if (s.tool_call_count > 0)
    parts.push(`${s.tool_call_count} tool${s.tool_call_count === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function ModelPill({ s }: { s: SessionSummary }) {
  const multi = s.models_used != null && s.models_used.length > 1;
  const last = multi ? s.models_used![s.models_used!.length - 1] : s.model;
  return html`
    <span class="model-pill ${modelClass(last)}">
      ${multi
        ? s.models_used!.map(
            (m: string, i: number) =>
              html`${i > 0 ? html`<span class="model-switch">→</span>` : null}${modelLabel(m)}`,
          )
        : modelLabel(s.model)}
      ${isLargeContext(last) ? html` <span class="ctx-label">1M</span>` : null}
    </span>
  `;
}

// ── Session row ─────────────────────────────────────────────────────

function SessionRow({ s, onOpen }: { s: SessionSummary; onOpen: (id: string) => void }) {
  const summary = (s.summary ?? "").trim();
  const startedName = s.started_with?.name;
  // The started-with pill carries the slash-command/skill name on the title
  // line. When the summary leads with that same name (e.g. pill "/triage-issue"
  // + summary "/triage-issue — 46"), drop the redundant prefix so the title
  // shows only the remainder ("46"); show nothing extra when nothing remains.
  const titleText = s.started_with
    ? stripPrefix(summary, startedName) || null
    : summary || "—";

  const meta = buildMeta(s);
  const skills = (s.invocations ?? [])
    .filter((i) => i.type === "skill")
    .map((i) => i.name);
  const compacted =
    s.compaction_count > 0 ? `${s.compaction_count}× compacted` : null;
  const subGroups: unknown[] = [];
  if (meta) subGroups.push(html`<span>${meta}</span>`);
  if (skills.length > 0)
    subGroups.push(
      html`${skills.map((n) => html`<span class="skill-badge">${n}</span>`)}`,
    );
  if (compacted) subGroups.push(html`<span>${compacted}</span>`);

  const startMs = new Date(s.started_at).getTime();
  const dur = s.duration_ms && s.duration_ms > 0 ? s.duration_ms : 0;
  const endedDate = new Date(startMs + dur);
  const rel = formatRelative(s.started_at);
  const clock = formatClock(endedDate);
  const timeTitle = `Started ${s.started_at}\nEnded ${isNaN(endedDate.getTime()) ? "—" : endedDate.toISOString()}`;

  const cost = s.cost_estimate_usd != null && s.cost_estimate_usd > 0
    ? `$${s.cost_estimate_usd.toFixed(2)}`
    : null;

  const cachePct = cacheHitPct(s);

  return html`
    <div class="srow" onClick=${() => onOpen(s.id)}>
      <div class="srow-main">
        <div class="srow-l1">
          <span class="proj-dot" style=${`background:${projectColor(s.project_name || "default")}`}></span>
          <span class="srow-proj">${s.project_name || "—"}</span>
          ${s.status === "running"
            ? html`<span class="active-dot" title="Active session"></span>`
            : null}
        </div>
        <div class="srow-title">
          ${s.started_with
            ? html`<span class="${s.started_with.type === "skill" ? "skill-badge" : "cmd-pill"} srow-title-pill">${s.started_with.name}</span>`
            : null}
          ${titleText
            ? html`<span class="srow-title-text">${titleText}</span>`
            : null}
        </div>
        <div class="srow-sub">
          ${subGroups.length > 0
            ? subGroups.map(
                (g, i) =>
                  html`${i > 0 ? html`<span class="tel-sep">·</span>` : null}${g}`,
              )
            : html`<span class="srow-sub-empty">—</span>`}
        </div>
      </div>
      <div class="srow-rail">
        <div class="rail-time" title=${timeTitle}>
          ${rel} <span class="rail-arrow">→</span> ${clock}
        </div>
        <div class="rail-model">${html`<${ModelPill} s=${s} />`}</div>
        <div class="rail-cost">
          ${formatDuration(s.duration_ms)}${cost
            ? html` · <span class="rail-usd">${cost}</span>`
            : null}
        </div>
        <div class="rail-tel">
          <span class=${ctxClass(s.peak_context_pct, s.models_used?.[s.models_used.length - 1] ?? s.model)}>
            ${Math.round(s.peak_context_pct)}% ctx
          </span>
          <span class="tel-sep">·</span>
          <span>${compactTokens(s.total_input_tokens)}↑ ${compactTokens(s.total_output_tokens)}↓</span>
          ${cachePct !== null
            ? html`<span class="tel-sep">·</span><span class=${cachePct < 50 ? "tel-cache-low" : ""}>${Math.round(cachePct)}% ⚡</span>`
            : null}
        </div>
      </div>
    </div>
  `;
}

// ── Sort / filter types ─────────────────────────────────────────────

type SortColumn =
  | "started_at"
  | "project_name"
  | "model"
  | "duration_ms"
  | "peak_context_pct"
  | "cost_estimate_usd";
type SortOrder = "asc" | "desc";

const SORT_COLUMN_TO_API: Record<SortColumn, string> = {
  started_at: "started_at",
  project_name: "project_name",
  model: "model",
  duration_ms: "duration_ms",
  peak_context_pct: "peak_context_pct",
  cost_estimate_usd: "cost_estimate_usd",
};

const VALID_SORT_COLS: SortColumn[] = [
  "started_at", "project_name", "model", "duration_ms", "peak_context_pct", "cost_estimate_usd",
];
const VALID_CHIPS: ChipFilter[] = ["all", "opus", "sonnet", "haiku"];

const PAGE_SIZE = 25;

// localStorage keys (Tier 2 cross-session preferences)
const LS_CHIP = "cm.sessionList.chipFilter";
const LS_PROJECT = "cm.sessionList.project";
const LS_SORT = "cm.sessionList.sort";

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
  const [modelPref, setModelPref] = usePersistentState<ChipFilter>(LS_CHIP, "all");
  const [projectPref, setProjectPref] = usePersistentState<string | null>(LS_PROJECT, null);
  const [sortPref, setSortPref] = usePersistentState<SortPref>(LS_SORT, DEFAULT_SORT);

  // Effective values: URL (Tier 1) overrides localStorage; otherwise pref wins.
  const urlModel = params.get("model");
  const urlProject = params.get("project");
  const urlSort = params.get("sort");
  const urlOrder = params.get("order");
  const urlQ = params.get("q") ?? "";

  const chipFilter: ChipFilter = (urlModel && VALID_CHIPS.includes(urlModel as ChipFilter))
    ? (urlModel as ChipFilter)
    : modelPref;
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

  // Search input ref + global "/" shortcut
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

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
    setModelPref(next);
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
    setModelPref("all");
    setProjectPref(null);
    setSortPref(DEFAULT_SORT);
    updateParams(
      { model: null, q: null, project: null, sort: null, order: null },
      "replace",
    );
  }

  // Adapter functions — bridge FilterBar's string types to typed enums
  function handleModelFilter(v: string) { setChipFilter(v as ChipFilter); }
  function handleApplySort(col: string, order: string) { applySort(col as SortColumn, order as SortOrder); }

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

  function navigateToSession(id: string) {
    location.hash = `#/session/${id}`;
  }

  // Date-group headers only make sense when rows are ordered by start time.
  const grouped = sortCol === "started_at";
  const bucketCounts = new Map<string, number>();
  if (grouped) {
    for (const s of sessions) {
      const k = dateBucket(s.started_at).key;
      bucketCounts.set(k, (bucketCounts.get(k) ?? 0) + 1);
    }
  }

  // Stats calculations
  const totalTokens = stats ? stats.total_input_tokens + stats.total_output_tokens : 0;

  // Count active sessions from loaded data
  const activeSessions = sessions.filter((s: SessionSummary) => s.status === "running").length;

  // Unique projects count — prefer the full list from /api/projects over the current page
  const uniqueProjects = projects.length > 0
    ? projects.length
    : new Set(sessions.map((s: SessionSummary) => s.project_name)).size;

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

      <${FilterBar}
        searchRef=${searchInputRef}
        searchQuery=${searchQuery}
        onSearch=${handleSearch}
        projects=${projects}
        selectedProject=${selectedProject}
        onSelectProject=${selectProject}
        modelFilter=${chipFilter}
        onModelFilter=${handleModelFilter}
        sortCol=${sortCol}
        sortOrder=${sortOrder}
        onApplySort=${handleApplySort}
        total=${total}
        loading=${loading}
        hasActiveFilters=${hasActiveFilters}
        onResetFilters=${resetFilters}
      />

      ${loading && sessions.length === 0 && html`<div class="status-text">Loading sessions...</div>`}
      ${loadError && sessions.length === 0 && html`<div class="error-text">${loadError}</div>`}
      ${!loading && !loadError && total === 0 && html`<div class="status-text">No sessions found.</div>`}

      ${sessions.length > 0 && html`
        <div class="session-list">
          ${(() => {
            let lastKey: string | null = null;
            return sessions.map((s: SessionSummary) => {
              let header = null;
              if (grouped) {
                const b = dateBucket(s.started_at);
                if (b.key !== lastKey) {
                  lastKey = b.key;
                  header = html`
                    <div class="date-group">
                      <span class="dg-label">${b.label}</span>
                      <span class="dg-count">${bucketCounts.get(b.key)}</span>
                    </div>
                  `;
                }
              }
              return html`${header}<${SessionRow} s=${s} onOpen=${navigateToSession} />`;
            });
          })()}
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
