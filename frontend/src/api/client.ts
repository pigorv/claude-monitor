import type { SessionListResponse, SessionDetailResponse, Event } from "../../../src/shared/types";

export interface EventsResponse {
  events: Event[];
  total: number;
  limit: number;
  offset: number;
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

export function fetchStats(): Promise<Record<string, any>> {
  return fetchApi<Record<string, any>>("/api/stats");
}
