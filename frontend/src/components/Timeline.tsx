import { useState, useEffect, useMemo } from "preact/hooks";
import { html } from "htm/preact";
import { fetchEvents } from "../api/client";
import { EventCard } from "./EventCard";
import { AgentGroup } from "./AgentGroup";
import { CompactionBanner } from "./CompactionBanner";
import type { Event, EventType } from "../../../src/shared/types";

interface TimelineProps {
  sessionId: string;
  sessionStart?: string;
}

const EVENT_TYPES: EventType[] = [
  "session_start",
  "session_end",
  "tool_call_start",
  "tool_call_end",
  "subagent_start",
  "subagent_end",
  "compaction",
  "thinking",
  "assistant_message",
  "user_message",
  "notification",
];

const PAGE_SIZE = 50;

export function Timeline({ sessionId, sessionStart }: TimelineProps) {
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

    fetchEvents(sessionId, {
      event_type: typeFilter || undefined,
      include_thinking: includeThinking ? "true" : undefined,
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

  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  const toggleToolGroup = (key: string) => {
    setExpandedToolGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Group consecutive agent events and same-type tool calls
  type TimelineItem =
    | { type: "event"; event: Event }
    | { type: "agent-group"; agentId: string; events: Event[]; agentDescription?: string }
    | { type: "compaction"; event: Event }
    | { type: "tool-group"; toolName: string; events: Event[]; groupKey: string };

  const getBashExitStatus = (evt: Event): "ok" | "fail" => {
    const output = evt.output_data || "";
    // Check for non-zero exit code
    const exitMatch = output.match(/"exit_code"\s*:\s*(\d+)/);
    if (exitMatch && exitMatch[1] !== "0") return "fail";
    return "ok";
  };

  const TOOL_GROUP_LABELS: Record<string, string> = {
    Glob: "file searches",
    Grep: "content searches",
    Read: "file reads",
    Write: "file writes",
    Edit: "file edits",
    Bash: "commands",
  };

  const groupedItems = useMemo((): TimelineItem[] => {
    const items: TimelineItem[] = [];
    let i = 0;
    while (i < events.length) {
      const evt = events[i];
      // Compaction events render as standalone banners
      if (evt.event_type === "compaction") {
        items.push({ type: "compaction", event: evt });
        i++;
      // If this event belongs to a sub-agent, group consecutive events with same agent_id
      } else if (evt.agent_id && evt.event_type !== "subagent_start" && evt.event_type !== "subagent_end") {
        const agentId = evt.agent_id;
        const group: Event[] = [evt];
        i++;
        while (i < events.length && events[i].agent_id === agentId && events[i].event_type !== "subagent_start" && events[i].event_type !== "subagent_end") {
          group.push(events[i]);
          i++;
        }
        // Try to extract description from the Agent/Task event that precedes this group
        let agentDescription: string | undefined;
        const prevItems = items;
        for (let j = prevItems.length - 1; j >= Math.max(0, prevItems.length - 3); j--) {
          const prev = prevItems[j];
          if (prev.type === "event" && prev.event.event_type === "tool_call_start" && (prev.event.tool_name === "Agent" || prev.event.tool_name === "Task")) {
            try {
              const input = JSON.parse(prev.event.input_data || "{}");
              if (input.description) agentDescription = input.description;
            } catch { /* ignore */ }
            break;
          }
        }
        items.push({ type: "agent-group", agentId, events: group, agentDescription });
      // Group consecutive same-type tool calls (2+ in a row)
      } else if (evt.event_type === "tool_call_start" && evt.tool_name && !evt.agent_id) {
        const toolName = evt.tool_name;
        let j = i + 1;
        while (j < events.length && events[j].event_type === "tool_call_start" && events[j].tool_name === toolName && !events[j].agent_id) {
          j++;
        }
        if (j - i >= 2) {
          const group = events.slice(i, j);
          items.push({ type: "tool-group", toolName, events: group, groupKey: `tg-${toolName}-${evt.id}` });
          i = j;
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
  }, [events]);

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

      ${loading && html`<div class="status-text">Loading events…</div>`}
      ${error && html`<div class="error-text">${error}</div>`}
      ${!loading && !error && events.length === 0 && html`<div class="status-text">No events found.</div>`}

      ${!loading && !error && events.length > 0 && html`
        <div class="timeline-events">
          ${groupedItems.map((item) =>
            item.type === "agent-group"
              ? html`<${AgentGroup}
                  key=${"ag-" + item.agentId + "-" + item.events[0].id}
                  agentId=${item.agentId}
                  events=${item.events}
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
                  const isBash = item.toolName === "Bash";
                  const failCount = isBash ? item.events.filter((e) => getBashExitStatus(e) === "fail").length : 0;
                  return html`
                  <div key=${item.groupKey} class=${"tool-group-row" + (isBash ? " bash-group" : "")}>
                    <div class="event-dot" style="background: transparent; border: 1.5px solid var(--text3);"></div>
                    <div class="event-content">
                      <div class="tool-group-header" onClick=${() => toggleToolGroup(item.groupKey)}>
                        <span class=${"tool-badge " + ({"Read":"tool-read","Write":"tool-write","Edit":"tool-write","Bash":"tool-bash","Agent":"tool-agent","Grep":"tool-read","Glob":"tool-read"}[item.toolName] || "")}>${item.toolName}</span>
                        <span class="tool-group-label">${item.events.length} ${TOOL_GROUP_LABELS[item.toolName] || "calls"}${isBash && failCount > 0 ? ` · ${failCount} failed` : ""}</span>
                        <span class="tool-group-arrow">${expandedToolGroups[item.groupKey] ? "▾" : "▸"}</span>
                      </div>
                      ${expandedToolGroups[item.groupKey] && html`
                        <div class="tool-group-items">
                          ${item.events.map((evt) => html`
                            <div class=${isBash ? "bash-item" : ""}>
                              ${isBash && html`<span class=${"status-dot " + getBashExitStatus(evt)}></span>`}
                              <${EventCard}
                                key=${evt.id}
                                event=${evt}
                                sessionStart=${sessionStart}
                              />
                            </div>
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
