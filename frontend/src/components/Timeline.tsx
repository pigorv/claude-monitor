import { useState, useEffect, useMemo } from "preact/hooks";
import { html } from "htm/preact";
import { fetchEvents } from "../api/client";
import { EventCard } from "./EventCard";
import { AgentGroup } from "./AgentGroup";
import { CompactionBanner } from "./CompactionBanner";
import { TokenBudgetBar } from "./TokenBudgetBar";
import type { Event, EventType, AgentRelationship } from "../../../src/shared/types";

interface TimelineProps {
  sessionId: string;
  sessionStart?: string;
  agents?: AgentRelationship[];
  parentInputTokens?: number;
  parentOutputTokens?: number;
}

const PAGE_SIZE = 50;

// -- Helpers for tool group rendering --

const BADGE_CLASS: Record<string, string> = {
  Read: "tool-read",
  Write: "tool-write",
  Edit: "tool-write",
  Bash: "tool-bash",
  Agent: "tool-agent",
  Grep: "tool-grep",
  Glob: "tool-glob",
};

function tryParseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return fullPath;
  return parts.slice(-2).join("/");
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getToolSummary(event: Event): string | null {
  if (event.event_type !== "tool_call_start" || !event.tool_name) return null;
  const input = tryParseJson(event.input_data);
  if (!input) return null;
  switch (event.tool_name) {
    case "Agent": {
      const subType = input.subagent_type || "Agent";
      return input.description ? `${subType}(${input.description})` : String(subType);
    }
    case "Skill":
      return input.skill ? `Skill(${input.skill})` : null;
    case "Bash":
      return (input.description as string) || truncate(String(input.command || ""), 60);
    case "Glob":
      return input.pattern ? String(input.pattern) : null;
    case "Grep":
      return input.pattern ? String(input.pattern) : null;
    case "Read":
      return input.file_path ? shortenPath(String(input.file_path)) : null;
    case "Write":
      return input.file_path ? shortenPath(String(input.file_path)) : null;
    case "Edit":
      return input.file_path ? shortenPath(String(input.file_path)) : null;
    default:
      return null;
  }
}

function hasToolError(evt: Event): boolean {
  const meta = tryParseJson(evt.metadata);
  if (meta?.tool_error) return true;
  if (meta?.permission_status === "rejected") return true;
  const output = evt.output_data || "";
  const exitMatch = output.match(/"exit_code"\s*:\s*(\d+)/);
  if (exitMatch && exitMatch[1] !== "0") return true;
  return false;
}

function getGroupDuration(groupEvents: Event[]): string | null {
  const totalMs = groupEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0);
  if (totalMs > 0) {
    if (totalMs < 1000) return `${totalMs}ms`;
    return `${(totalMs / 1000).toFixed(1)}s`;
  }
  if (groupEvents.length < 2) return null;
  const first = new Date(groupEvents[0].timestamp).getTime();
  const last = new Date(groupEvents[groupEvents.length - 1].timestamp).getTime();
  const diffMs = last - first;
  if (diffMs <= 0) return null;
  if (diffMs < 1000) return `${diffMs}ms`;
  return `${(diffMs / 1000).toFixed(1)}s`;
}

export type TimelineItem =
  | { type: "event"; event: Event }
  | { type: "agent-group"; agentId: string; agent: AgentRelationship; agentDescription?: string }
  | { type: "compaction"; event: Event }
  | { type: "tool-group"; events: Event[]; groupKey: string }
  | { type: "system-group"; events: Event[] };

export function groupTimelineItems(events: Event[], agents?: AgentRelationship[]): TimelineItem[] {
  const hasAgentData = agents && agents.length > 0;
  const sortedAgents = hasAgentData
    ? [...agents!].sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""))
    : [];

  const items: TimelineItem[] = [];
  const agentInserted = new Set<string>();
  let i = 0;

  while (i < events.length) {
    const evt = events[i];

    // When we have agent data and parent_only mode, Agent/Task tool calls become agent groups
    if (hasAgentData && evt.event_type === "tool_call_start" && (evt.tool_name === "Agent" || evt.tool_name === "Task") && !evt.agent_id) {
      const toolMs = new Date(evt.timestamp).getTime();

      let nextParentMs = toolMs + 30_000;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].event_type !== "tool_call_start" || (events[j].tool_name !== "Agent" && events[j].tool_name !== "Task")) {
          nextParentMs = new Date(events[j].timestamp).getTime();
          break;
        }
      }

      const matched: AgentRelationship[] = [];
      for (const a of sortedAgents) {
        if (agentInserted.has(a.child_agent_id)) continue;
        if (!a.started_at) continue;
        const agentMs = new Date(a.started_at).getTime();
        if (agentMs >= toolMs && agentMs < nextParentMs) {
          matched.push(a);
        }
      }

      for (const a of matched) {
        agentInserted.add(a.child_agent_id);
        items.push({
          type: "agent-group",
          agentId: a.child_agent_id,
          agent: a,
          agentDescription: a.prompt_preview || undefined,
        });
      }

      let nextI = i + 1;
      while (nextI < events.length
        && events[nextI].event_type === "tool_call_start"
        && (events[nextI].tool_name === "Agent" || events[nextI].tool_name === "Task")
        && !events[nextI].agent_id) {
        nextI++;
      }

      if (matched.length === 0) {
        items.push({ type: "event", event: evt });
      }

      i = nextI;
      continue;
    }

    // Fallback: agent events in non-parent-only mode
    if (evt.agent_id) {
      i++;
      continue;
    }

    // Compaction events render as standalone banners
    if (evt.event_type === "compaction") {
      items.push({ type: "compaction", event: evt });
      i++;
    // Group consecutive tool calls of the SAME tool type (2+ in a row)
    } else if (evt.event_type === "tool_call_start" && evt.tool_name) {
      const toolName = evt.tool_name;
      let j = i + 1;
      while (j < events.length && events[j].event_type === "tool_call_start" && events[j].tool_name === toolName && !events[j].agent_id) {
        j++;
      }
      if (j - i >= 2) {
        const group = events.slice(i, j);
        items.push({ type: "tool-group", events: group, groupKey: `tg-${evt.id}` });
        i = j;
      } else {
        items.push({ type: "event", event: evt });
        i++;
      }
    // Group consecutive system-generated user messages
    } else if (evt.event_type === 'user_message') {
      const evtMeta = tryParseJson(evt.metadata);
      if (evtMeta?.subtype === 'system_generated' && !evtMeta?.command) {
        // Look ahead for consecutive system_generated messages
        let j = i + 1;
        while (j < events.length) {
          const nextEvt = events[j];
          if (nextEvt.event_type !== 'user_message') break;
          const nextMeta = tryParseJson(nextEvt.metadata);
          if (nextMeta?.subtype !== 'system_generated' || nextMeta?.command) break;
          j++;
        }
        if (j - i >= 2) {
          items.push({ type: "system-group", events: events.slice(i, j) });
          i = j;
        } else {
          items.push({ type: "event", event: evt });
          i++;
        }
      } else {
        items.push({ type: "event", event: evt });
        i++;
      }
    } else {
      items.push({ type: "event", event: evt });
      i++;
    }
  }
  return items;
}

export function Timeline({ sessionId, sessionStart, agents, parentInputTokens, parentOutputTokens }: TimelineProps) {
  const [events, setEvents] = useState<Event[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [includeThinking, setIncludeThinking] = useState(true);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setOffset(0);
  }, [typeFilter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const hasAgents = agents && agents.length > 0;
    fetchEvents(sessionId, {
      event_type: typeFilter || undefined,
      include_thinking: includeThinking ? "true" : undefined,
      parent_only: hasAgents && !typeFilter ? "true" : undefined,
      limit: PAGE_SIZE,
      offset,
    })
      .then((res) => {
        if (!cancelled) {
          setEvents(res.events);
          setTotal(res.total);
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
  }, [sessionId, typeFilter, includeThinking, offset]);

  const toggleToolGroup = (key: string) => {
    setExpandedToolGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const groupedItems = useMemo(() => groupTimelineItems(events, agents), [events, agents]);

  // Token budget bar data
  const budgetData = useMemo(() => {
    if (!agents || agents.length === 0) return null;
    const agentItems = agents
      .filter((a) => (a.input_tokens_total || 0) + (a.output_tokens_total || 0) > 0)
      .map((a) => ({
        agentId: a.child_agent_id,
        description: a.prompt_preview || a.child_agent_id.slice(0, 12),
        tokens: (a.input_tokens_total || 0) + (a.output_tokens_total || 0),
      }));
    if (agentItems.length === 0) return null;

    const agentTotal = agentItems.reduce((sum, a) => sum + a.tokens, 0);
    const sessionTotal = (parentInputTokens || 0) + (parentOutputTokens || 0);
    const parentTokens = Math.max(0, sessionTotal - agentTotal);

    return { parentTokens, agents: agentItems };
  }, [agents, parentInputTokens, parentOutputTokens]);

  return html`
    <div class="timeline">
      <div class="timeline-toolbar">
        <div class="timeline-chips">
          ${[
            { label: "All", value: "" },
            { label: "User", value: "user_message" },
            { label: "Assistant", value: "assistant_message" },
            { label: "Tools", value: "tool_call_start" },
            { label: "Thinking", value: "thinking" },
            { label: "Agents", value: "subagent_start" },
          ].map((chip) => html`
            <button
              key=${chip.value}
              class=${"chip" + (typeFilter === chip.value ? " active" : "")}
              onClick=${() => setTypeFilter(chip.value)}
            >${chip.label}</button>
          `)}
        </div>

        <div class="timeline-toolbar-right">
          <span class="timeline-count">${total} events</span>
        </div>
      </div>

      ${budgetData && html`
        <${TokenBudgetBar}
          parentTokens=${budgetData.parentTokens}
          agents=${budgetData.agents}
        />
      `}

      ${loading && html`<div class="status-text">Loading events…</div>`}
      ${error && html`<div class="error-text">${error}</div>`}
      ${!loading && !error && events.length === 0 && html`<div class="status-text">No events found.</div>`}

      ${!loading && !error && events.length > 0 && html`
        <div class="timeline-events">
          ${groupedItems.map((item) =>
            item.type === "agent-group"
              ? html`<${AgentGroup}
                  key=${"ag-" + item.agentId}
                  agentId=${item.agentId}
                  sessionId=${sessionId}
                  agent=${item.agent}
                  sessionStart=${sessionStart}
                  agentDescription=${item.agentDescription}
                />`
              : item.type === "compaction"
              ? html`<${CompactionBanner}
                  key=${"c-" + item.event.id}
                  event=${item.event}
                />`
              : item.type === "tool-group"
              ? (() => {
                  const failCount = item.events.filter((e) => hasToolError(e)).length;
                  const duration = getGroupDuration(item.events);
                  const uniqueTools = [...new Set(item.events.map((e) => e.tool_name).filter(Boolean))] as string[];
                  return html`
                  <div key=${item.groupKey} class="tool-group-row">
                    <div class="event-dot dot-tool-grp"></div>
                    <div class="event-content">
                      <div class="tool-group-header" onClick=${() => toggleToolGroup(item.groupKey)}>
                        <span class="tg-badges">
                          ${uniqueTools.map((t) => html`
                            <span class=${"tool-badge " + (BADGE_CLASS[t] || "")}>${t}</span>
                          `)}
                        </span>
                        <span class="tool-group-label">${item.events.length} calls</span>
                        <span class="tg-meta">
                          ${failCount > 0 && html`<span class="tg-failed">${failCount} failed</span>`}
                          ${duration && html`<span>${duration}</span>`}
                          <span class="tool-group-arrow">${expandedToolGroups[item.groupKey] ? "▾" : "▸"}</span>
                        </span>
                      </div>
                      ${expandedToolGroups[item.groupKey] && html`
                        <div class="tool-group-card">
                          ${item.events.map((evt) => html`
                            <${EventCard}
                              key=${evt.id}
                              event=${evt}
                              sessionStart=${sessionStart}
                            />
                          `)}
                        </div>
                      `}
                    </div>
                  </div>
                `;
                })()
              : item.type === "system-group"
              ? (() => {
                  const groupKey = `sg-${item.events[0].id}`;
                  const isExpanded = expandedToolGroups[groupKey];
                  const firstPreview = item.events[0].input_preview || '[system message]';
                  return html`
                    <div key=${groupKey} class="event-card">
                      <div class="event-dot dot-sys"></div>
                      <div class="event-content">
                        <div class="sys-group" onClick=${() => toggleToolGroup(groupKey)}>
                          <span class="sys-label">system</span>
                          <span class="sys-count">×${item.events.length}</span>
                          <span class="sys-text">${truncate(firstPreview, 60)}</span>
                          <span class="sys-expand">${isExpanded ? '▾' : '▸'}</span>
                        </div>
                        ${isExpanded && html`
                          <div style="margin-top: 4px;">
                            ${item.events.map(evt => html`
                              <${EventCard} key=${evt.id} event=${evt} sessionStart=${sessionStart} />
                            `)}
                          </div>
                        `}
                      </div>
                    </div>
                  `;
                })()
              : html`<${EventCard}
                  key=${item.event.id}
                  event=${item.event}
                  sessionStart=${sessionStart}
                />`
          )}
        </div>

        ${total > PAGE_SIZE && html`
          <div class="pagination">
            <button
              class="pg-btn"
              disabled=${offset === 0}
              onClick=${() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            >
              ← Prev
            </button>
            <span class="pg-info">${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}</span>
            <button
              class="pg-btn"
              disabled=${offset + PAGE_SIZE >= total}
              onClick=${() => setOffset(offset + PAGE_SIZE)}
            >
              Next →
            </button>
          </div>
        `}
      `}
    </div>
  `;
}
