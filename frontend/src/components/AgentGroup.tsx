import { useState, useMemo, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { fetchEvents } from "../api/client";
import { EventCard } from "./EventCard";
import type { Event, AgentRelationship } from "../../../src/shared/types";

interface AgentGroupProps {
  agentId: string;
  sessionId: string;
  agent?: AgentRelationship;
  events?: Event[];
  sessionStart?: string;
  agentDescription?: string;
}

function tryParseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const TOOL_TRUNCATE_THRESHOLD = 5;
const TOOL_SHOW_INITIAL = 3;

export function AgentGroup({ agentId, sessionId, agent, events: propEvents, sessionStart, agentDescription }: AgentGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAllTools, setShowAllTools] = useState(false);
  const [lazyEvents, setLazyEvents] = useState<Event[] | null>(null);
  const [loadingEvents, setLoadingEvents] = useState(false);

  // Lazy-load agent events when expanded (only if no propEvents)
  useEffect(() => {
    if (!expanded || propEvents || lazyEvents || loadingEvents) return;
    setLoadingEvents(true);
    fetchEvents(sessionId, { agent_id: agentId, limit: 500 })
      .then((res) => { setLazyEvents(res.events); setLoadingEvents(false); })
      .catch(() => setLoadingEvents(false));
  }, [expanded, sessionId, agentId, propEvents, lazyEvents, loadingEvents]);

  const events = propEvents || lazyEvents || [];

  // Use agent relationship data for header metadata when available
  const meta = useMemo(() => {
    const description = agentDescription || agent?.prompt_preview || null;

    // When we have agent relationship data, use it directly for the header
    if (agent) {
      const totalTokens = (agent.input_tokens_total || 0) + (agent.output_tokens_total || 0);
      const durationMs = agent.duration_ms || 0;
      const status = (agent.status === "completed" ? "completed" : agent.status === "failed" ? "failed" : "running") as "completed" | "running" | "failed";

      const agentStartMs = agent.started_at ? new Date(agent.started_at).getTime() : 0;
      return { description, agentStartMs, durationMs, totalTokens, status, eventCount: agent.tool_call_count || events.length };
    }

    // Fallback: compute from events (legacy path)
    let agentStartMs = 0;
    let durationMs = 0;
    let totalTokens = 0;
    let status: "completed" | "running" | "failed" = "running";

    if (events.length > 0) {
      agentStartMs = new Date(events[0].timestamp).getTime();
      const lastEvt = events[events.length - 1];
      durationMs = new Date(lastEvt.timestamp).getTime() - agentStartMs;
    }

    for (const evt of events) {
      totalTokens += (evt.input_tokens || 0) + (evt.output_tokens || 0);
      if (evt.event_type === "subagent_end") status = "completed";
    }

    return { description, agentStartMs, durationMs, totalTokens, status, eventCount: events.length };
  }, [events, agent, agentDescription]);

  // Map each Write/Edit tool_call_start to the thinking_summary of the nearest
  // preceding thinking event since the last user_message within this agent's
  // own event stream — mirrors the parent Timeline's rationale attribution.
  const rationaleMap = useMemo(() => {
    const map = new Map<number, string>();
    let current: string | null = null;
    for (const e of events) {
      if (e.event_type === "user_message") {
        current = null;
      } else if (e.event_type === "thinking" && e.thinking_summary && e.thinking_summary.trim()) {
        current = e.thinking_summary;
      } else if (
        e.event_type === "tool_call_start"
        && (e.tool_name === "Write" || e.tool_name === "Edit")
        && current
      ) {
        map.set(e.id, current);
      }
    }
    return map;
  }, [events]);

  const shortId = agentId.length > 16 ? agentId.slice(0, 16) : agentId;

  // Separate events into groups for truncation
  const renderEvents = useMemo(() => {
    type RenderItem =
      | { kind: "tool"; evt: Event }
      | { kind: "other"; evt: Event };

    const items: RenderItem[] = events
      .filter((e) => e.event_type !== "subagent_start" && e.event_type !== "subagent_end")
      .map((evt) => ({
        kind: (evt.event_type === "tool_call_start" && evt.tool_name) ? "tool" as const : "other" as const,
        evt,
      }));

    // Group consecutive tool calls for truncation
    type Chunk =
      | { type: "tools"; events: Event[] }
      | { type: "single"; evt: Event };

    const chunks: Chunk[] = [];
    let i = 0;
    while (i < items.length) {
      if (items[i].kind === "tool") {
        const tools: Event[] = [items[i].evt];
        i++;
        while (i < items.length && items[i].kind === "tool") {
          tools.push(items[i].evt);
          i++;
        }
        chunks.push({ type: "tools", events: tools });
      } else {
        chunks.push({ type: "single", evt: items[i].evt });
        i++;
      }
    }

    return chunks;
  }, [events]);

  return html`
    <div class="agent-block">
      <div class="agent-block-header" onClick=${() => setExpanded(!expanded)}>
        <span class="agent-block-caret"><svg width="10" height="10" viewBox="0 0 10 10" fill="none" style=${"transform:rotate(" + (expanded ? "90deg" : "0deg") + ");transition:transform 0.2s"}><path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="agent-block-dot"></span>
        <span class="agent-block-id">${shortId}</span>
        ${meta.description
          ? html`<span class="agent-block-desc">${meta.description}</span>`
          : null
        }
        <span class="agent-block-meta">
          <span>${meta.eventCount} events</span>
          ${meta.durationMs > 0 && html`<span>${formatDuration(meta.durationMs)}</span>`}
          ${meta.totalTokens > 0 && html`<span>${formatTokens(meta.totalTokens)} tok</span>`}
          <span class=${"agent-block-status " + meta.status}>${meta.status}</span>
        </span>
      </div>
      <div class=${"agent-block-body" + (expanded ? " show" : "")}>
        ${loadingEvents && html`<div style="padding:8px 12px;font-size:12px;color:var(--color-text-tertiary)">Loading agent events…</div>`}
        <div class="agent-events">
          ${renderEvents.map((chunk) => {
            if (chunk.type === "single") {
              const evt = chunk.evt;
              return html`<${EventCard} key=${evt.id} event=${evt} sessionStart=${sessionStart} rationale=${rationaleMap.get(evt.id)} />`;
            }
            // Tool chunk with truncation (#4)
            const tools = chunk.events;
            const canTruncate = tools.length > TOOL_TRUNCATE_THRESHOLD;
            const visibleTools = canTruncate && !showAllTools ? tools.slice(0, TOOL_SHOW_INITIAL) : tools;
            const hiddenCount = tools.length - TOOL_SHOW_INITIAL;

            return html`
              ${visibleTools.map((evt) => html`<${EventCard} key=${evt.id} event=${evt} sessionStart=${sessionStart} rationale=${rationaleMap.get(evt.id)} />`)}
              ${canTruncate && html`
                <div class="expand-hint" onClick=${(e: globalThis.Event) => { e.stopPropagation(); setShowAllTools(!showAllTools); }}>
                  ${showAllTools ? "Collapse" : `+ ${hiddenCount} more tool calls`}
                </div>
              `}
            `;
          })}
        </div>
      </div>
    </div>
  `;
}
