import type { AgentRelationship } from "../../../src/shared/types";

/** Hour/minute/second duration formatter. Collapses zero trailing units.
 *  e.g. 82_697_000 → "22h 57m", 113_000 → "1m 53s", 45_000 → "45s". */
export function formatHMS(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export interface GanttWindow {
  /** Absolute epoch ms of the window's left edge. */
  windowStartMs: number;
  /** windowStartMs minus session start, for session-relative axis labels (>= 0). */
  offsetMs: number;
  /** Framed window length in ms (activity window, used for bar/axis layout). */
  duration: number;
  /** Session start → last agent end, in ms — for the "Session:" duration labels. */
  sessionDuration: number;
}

/** Resolve an agent's end time, preferring `started_at + duration_ms` (most accurate),
 *  then `ended_at`, then the bare start instant. Returns null if it has no start. */
function agentEndMs(agent: AgentRelationship): { start: number; end: number } | null {
  if (!agent.started_at) return null;
  const start = new Date(agent.started_at).getTime();
  if (agent.duration_ms) return { start, end: start + agent.duration_ms };
  if (agent.ended_at) return { start, end: new Date(agent.ended_at).getTime() };
  return { start, end: start };
}

/** Frame the Gantt to the agent-activity window (first agent start → last agent end)
 *  with a small lead/trail margin, instead of the full session span. This keeps
 *  short agents legible in long (multi-hour) sessions. */
export function computeGanttWindow(
  agents: AgentRelationship[],
  sessionStart?: string,
): GanttWindow {
  if (!sessionStart) return { windowStartMs: 0, offsetMs: 0, duration: 0, sessionDuration: 0 };
  const sessionMs = new Date(sessionStart).getTime();

  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const a of agents) {
    const span = agentEndMs(a);
    if (!span) continue;
    if (span.start < minStart) minStart = span.start;
    if (span.end > maxEnd) maxEnd = span.end;
  }

  // No agents with timing — nothing to frame.
  if (!isFinite(minStart)) return { windowStartMs: sessionMs, offsetMs: 0, duration: 0, sessionDuration: 0 };

  const activity = Math.max(maxEnd - minStart, 1000); // at least 1s
  const margin = activity * 0.05; // small lead/trail
  const windowStart = Math.max(minStart - margin, sessionMs); // never precede session start
  const windowEnd = maxEnd + margin;

  return {
    windowStartMs: windowStart,
    offsetMs: windowStart - sessionMs,
    duration: windowEnd - windowStart,
    sessionDuration: maxEnd - sessionMs, // session start → last agent end
  };
}

/** Minimum bar width as a % of the track. The readable pixel floor lives in CSS
 *  (`.gantt-bar { min-width }`); this just keeps zero-duration bars visible. */
const MIN_BAR_PCT = 1.5;

/** Position a bar within the framed window. `left`/`width` are percentages. */
export function ganttPosition(
  agent: AgentRelationship,
  windowStartMs: number,
  duration: number,
): { left: number; width: number } {
  if (!agent.started_at || duration <= 0) return { left: 0, width: MIN_BAR_PCT };
  const start = new Date(agent.started_at).getTime() - windowStartMs;
  const dur = agent.duration_ms || 1000;
  const width = Math.max(MIN_BAR_PCT, (dur / duration) * 100);
  const left = Math.max(0, Math.min(100 - width, (start / duration) * 100));
  return { left, width };
}

/** Interval ladder (seconds): 10s … 1d. Capped so the axis never explodes into a
 *  wall of one-minute ticks on long sessions. */
const INTERVALS = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400];
const MAX_TICKS = 8;

/** Compute nice time-axis ticks across the framed window. Labels are session-relative
 *  offsets (`+22h 57m`), matching the table's "Started +Xm" column. `offsetMs` is the
 *  window start's offset from session start. Returns `{ label, ms }` where `ms` is the
 *  session-relative offset of the tick. */
export function computeTimeAxis(offsetMs: number, durationMs: number): { label: string; ms: number }[] {
  if (durationMs <= 0) return [];
  const totalSec = durationMs / 1000;

  let interval = INTERVALS[INTERVALS.length - 1];
  for (const iv of INTERVALS) {
    if (totalSec / iv <= MAX_TICKS) { interval = iv; break; }
  }
  // Hard fallback: even the largest predefined interval is too dense — round up to
  // whole hours so the loop can never fall through to a 1-minute default.
  if (totalSec / interval > MAX_TICKS) {
    interval = Math.ceil(totalSec / MAX_TICKS / 3600) * 3600;
  }

  const ticks: { label: string; ms: number }[] = [];
  for (let s = 0; s <= totalSec + 0.5; s += interval) {
    const ms = offsetMs + s * 1000;
    ticks.push({ label: `+${formatHMS(ms)}`, ms });
  }
  return ticks;
}
