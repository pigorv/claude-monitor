import type { SessionListResponse, SessionDetailResponse, Event, ProjectInfo, HealthResponse, TokenBudget } from "../../../src/shared/types";

export type { TokenBudget };

export interface EventsResponse {
  events: Event[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventTypeCounts {
  all: number;
  user_message: number;
  assistant_message: number;
  tool_call_start: number;
}

export async function fetchApi<T>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  let url = path;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function fetchSessions(
  params?: Record<string, string | number | undefined>
): Promise<SessionListResponse> {
  return fetchApi<SessionListResponse>("/api/sessions", params);
}

export function fetchSession(id: string): Promise<SessionDetailResponse> {
  return fetchApi<SessionDetailResponse>(`/api/sessions/${encodeURIComponent(id)}`);
}

export function fetchEvents(
  sessionId: string,
  params?: Record<string, string | number | undefined>
): Promise<EventsResponse> {
  return fetchApi<EventsResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/events`,
    params
  );
}

export function fetchEventCounts(
  sessionId: string,
  params?: Record<string, string | number | undefined>
): Promise<{ counts: EventTypeCounts }> {
  return fetchApi<{ counts: EventTypeCounts }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/event-counts`,
    params
  );
}

export function fetchStats(): Promise<Record<string, any>> {
  return fetchApi<Record<string, any>>("/api/stats");
}

export interface ReimportStatus {
  running: boolean;
  phase: "idle" | "importing" | "vacuuming" | "done";
  total: number;
  processed: number;
  imported: number;
  errors: number;
  done: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/**
 * Kick off a background reimport. POST returns immediately:
 *   202 ⇒ a run was started, 409 ⇒ a run is already in progress.
 * Cannot use fetchApi because 409 is a normal outcome, not an error.
 */
export async function startReimport(): Promise<{
  started: boolean;
  conflict: boolean;
}> {
  const res = await fetch("/api/reimport", { method: "POST" });
  if (res.status === 202) return { started: true, conflict: false };
  if (res.status === 409) return { started: false, conflict: true };
  const text = await res.text().catch(() => res.statusText);
  throw new Error(`API ${res.status}: ${text}`);
}

export function fetchReimportStatus(): Promise<ReimportStatus> {
  return fetchApi<ReimportStatus>("/api/reimport/status");
}

export function fetchProjects(): Promise<{ projects: ProjectInfo[] }> {
  return fetchApi<{ projects: ProjectInfo[] }>("/api/projects");
}

export type DarwinTerminalApp = "terminal" | "iterm2";
export type Win32TerminalApp = "wt" | "powershell" | "cmd";
export type TerminalApp = DarwinTerminalApp | Win32TerminalApp;
export type TerminalPreference = "auto" | TerminalApp;

export async function openTerminal(
  sessionId: string,
  terminal: TerminalPreference,
): Promise<{ success: true; terminal: TerminalApp }> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/open-terminal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ terminal }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message || `API ${res.status}`);
  }
  return res.json();
}

/**
 * Extract the download filename from a `Content-Disposition` header value.
 * Pure and DOM-free so it can be unit-tested. Handles quoted
 * (`attachment; filename="x.zip"`) and unquoted (`attachment; filename=x.zip`)
 * forms; returns `fallback` for null/blank headers or ones without a usable
 * filename.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename\s*=\s*("([^"]*)"|([^;]*))/i.exec(header);
  if (!match) return fallback;
  const value = (match[2] ?? match[3] ?? "").trim();
  return value || fallback;
}

/**
 * Download a session's export bundle. Fetches
 * `/api/sessions/:id/export` (adding `?sanitize=false` only for the raw mode),
 * then triggers a blob download using the server-provided filename from the
 * `Content-Disposition` header — never a full-page navigation. On a non-ok
 * response it surfaces the server's actionable `error` message.
 */
export async function downloadSessionExport(
  sessionId: string,
  { raw }: { raw: boolean },
): Promise<void> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/export${raw ? "?sanitize=false" : ""}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = (body as { error?: string }).error;
    throw new Error(error || `API ${res.status}`);
  }

  const filename = filenameFromDisposition(
    res.headers.get("content-disposition"),
    `claude-monitor-session-${sessionId}${raw ? "-raw" : ""}.zip`,
  );
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

let _platform: Promise<string> | null = null;

export function getPlatform(): Promise<string> {
  if (!_platform) {
    _platform = fetchApi<HealthResponse>("/api/health").then((h) => h.platform ?? "unknown");
  }
  return _platform.catch(() => {
    // Don't cache a transient failure — clear it so a later call retries
    // instead of leaving the button disabled until a full page reload.
    _platform = null;
    return "unknown";
  });
}
