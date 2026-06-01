import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { formatHMS, computeGanttWindow, ganttPosition, computeTimeAxis } from '../../frontend/src/lib/gantt.js';
import type { AgentRelationship } from '../../src/shared/types.js';

/** Minimal agent factory — only the fields the Gantt math reads. */
function agent(started_at: string | null, duration_ms: number | null, ended_at: string | null = null): AgentRelationship {
  return { started_at, duration_ms, ended_at } as unknown as AgentRelationship;
}

const SESSION_START = '2026-05-24T00:00:00.000Z';
function plusMin(min: number, sec = 0): string {
  return new Date(new Date(SESSION_START).getTime() + (min * 60 + sec) * 1000).toISOString();
}

describe('formatHMS', () => {
  it('emits hours for long durations', () => {
    assert.equal(formatHMS(1377 * 60 * 1000), '22h 57m'); // 1377 min
  });
  it('emits h with no minutes when minutes are zero', () => {
    assert.equal(formatHMS(2 * 3600 * 1000), '2h');
  });
  it('emits minutes and seconds', () => {
    assert.equal(formatHMS(113_000), '1m 53s');
  });
  it('collapses zero seconds', () => {
    assert.equal(formatHMS(5 * 60 * 1000), '5m');
  });
  it('emits bare seconds under a minute', () => {
    assert.equal(formatHMS(45_000), '45s');
  });
});

describe('computeTimeAxis', () => {
  it('caps ticks and emits hour labels for a 23h session (the explosion bug)', () => {
    const dayMs = 1378 * 60 * 1000; // ~23h
    const ticks = computeTimeAxis(0, dayMs);
    assert.ok(ticks.length <= 8, `expected <= 8 ticks, got ${ticks.length}`);
    assert.ok(ticks.length > 1);
    assert.ok(ticks.some((t) => t.label.includes('h')), 'expected hour-unit labels');
  });

  it('uses fine-grained ticks for a short window (no regression)', () => {
    const ticks = computeTimeAxis(0, 300 * 1000); // 5 min
    assert.ok(ticks.length <= 8 && ticks.length >= 4);
    assert.equal(ticks[0].label, '+0s');
  });

  it('keeps tick count bounded for multi-day windows (hard fallback)', () => {
    const threeDays = 3 * 24 * 3600 * 1000;
    const ticks = computeTimeAxis(0, threeDays);
    assert.ok(ticks.length <= 8, `expected <= 8 ticks, got ${ticks.length}`);
  });

  it('labels are session-relative (offset applied)', () => {
    const offset = 800 * 60 * 1000; // window starts +800m into session
    const ticks = computeTimeAxis(offset, 600 * 1000);
    assert.equal(ticks[0].ms, offset);
    assert.equal(ticks[0].label, '+13h 20m');
  });

  it('returns no ticks for a zero-duration window', () => {
    assert.deepEqual(computeTimeAxis(0, 0), []);
  });
});

describe('computeGanttWindow', () => {
  it('frames to the agent-activity window, not the full session', () => {
    // Agents run +800m..+810m of a session that is otherwise hours long.
    const agents = [agent(plusMin(800), 2 * 60 * 1000), agent(plusMin(805), 5 * 60 * 1000)];
    const w = computeGanttWindow(agents, SESSION_START);
    // first start = +800m, last end = +810m → activity span 10m, 5% margin = 30s
    assert.ok(w.offsetMs > 799 * 60 * 1000 && w.offsetMs < 800 * 60 * 1000, 'window starts just before first agent');
    // duration ~ 10m + 2*30s margin = 11m
    const durMin = w.duration / 60000;
    assert.ok(durMin > 10.5 && durMin < 11.5, `expected ~11m window, got ${durMin}m`);
    // sessionDuration spans session start → last agent end (+810m), not the window.
    assert.equal(w.sessionDuration / 60000, 810);
  });

  it('never frames before session start', () => {
    // Agent starts at the session start — the lead margin would push the window
    // before t=0, so it must clamp to the session start instead.
    const agents = [agent(plusMin(0), 60 * 1000)];
    const w = computeGanttWindow(agents, SESSION_START);
    assert.equal(w.offsetMs, 0, 'offset clamped to 0');
    assert.equal(w.windowStartMs, new Date(SESSION_START).getTime());
  });

  it('uses started_at + duration_ms for the end (ignores wrong ended_at)', () => {
    // ended_at equals started_at (the issue's data quirk) — must still use duration.
    const start = plusMin(100);
    const agents = [agent(start, 5 * 60 * 1000, start)];
    const w = computeGanttWindow(agents, SESSION_START);
    assert.ok(w.duration / 60000 > 5, 'duration reflects duration_ms, not the bogus ended_at');
  });

  it('returns a zero-duration window when no agents have timing', () => {
    const w = computeGanttWindow([agent(null, null)], SESSION_START);
    assert.equal(w.duration, 0);
    assert.equal(w.offsetMs, 0);
  });

  it('returns empty window with no sessionStart', () => {
    const w = computeGanttWindow([agent(plusMin(1), 1000)], undefined);
    assert.deepEqual(w, { windowStartMs: 0, offsetMs: 0, duration: 0, sessionDuration: 0 });
  });
});

describe('ganttPosition', () => {
  it('positions a bar relative to the framed window', () => {
    const w = computeGanttWindow(
      [agent(plusMin(800), 2 * 60 * 1000), agent(plusMin(805), 2 * 60 * 1000)],
      SESSION_START,
    );
    const p1 = ganttPosition(agent(plusMin(800), 2 * 60 * 1000), w.windowStartMs, w.duration);
    const p2 = ganttPosition(agent(plusMin(805), 2 * 60 * 1000), w.windowStartMs, w.duration);
    assert.ok(p2.left > p1.left, 'later agent sits further right within the window');
    assert.ok(p1.left >= 0 && p2.left + p2.width <= 100, 'bars stay within the track');
  });

  it('honours the minimum width floor', () => {
    const p = ganttPosition(agent(plusMin(0), 1), 0, 24 * 3600 * 1000);
    assert.ok(p.width >= 1.5, 'tiny bar clamped to min width');
  });

  it('clamps left so a bar never overflows the right edge', () => {
    const p = ganttPosition(agent(plusMin(0), 1000), 0, 1000); // start == window end
    assert.ok(p.left + p.width <= 100 + 1e-9);
  });

  it('falls back for an agent with no start', () => {
    const p = ganttPosition(agent(null, null), 0, 1000);
    assert.deepEqual(p, { left: 0, width: 1.5 });
  });
});
