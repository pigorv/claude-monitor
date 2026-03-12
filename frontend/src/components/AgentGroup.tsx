import { useState, useMemo } from "preact/hooks";
import { html } from "htm/preact";
import { EventCard } from "./EventCard";
import type { Event } from "../../../src/shared/types";

interface AgentGroupProps {
  agentId: string;
  events: Event[];
  sessionStart?: string;
  agentDescription?: string;
}

export function AgentGroup({ agentId, events, sessionStart, agentDescription }: AgentGroupProps) {
  const [expanded, setExpanded] = useState(true);

  // Try to extract description from the Agent tool_call_start event in the group
  const description = useMemo(() => {
    if (agentDescription) return agentDescription;
    // Look for the Agent tool_call event that spawned this group
    for (const evt of events) {
      if (evt.event_type === "tool_call_start" && (evt.tool_name === "Agent" || evt.tool_name === "Task")) {
        try {
          const input = JSON.parse(evt.input_data || "{}");
          if (input.description) return input.description;
        } catch { /* ignore */ }
      }
    }
    return null;
  }, [events, agentDescription]);

  // Determine agent type label
  const agentType = useMemo(() => {
    for (const evt of events) {
      if (evt.event_type === "tool_call_start" && (evt.tool_name === "Agent" || evt.tool_name === "Task")) {
        try {
          const input = JSON.parse(evt.input_data || "{}");
          return input.subagent_type || "Agent";
        } catch { /* ignore */ }
        return evt.tool_name;
      }
    }
    return "Agent";
  }, [events]);

  return html`
    <div class="agent-group">
      <div class="agent-group-header" onClick=${() => setExpanded(!expanded)} style="cursor: pointer;">
        <span class="agent-group-chevron">${expanded ? "▾" : "▸"}</span>
        <span class="agent-group-dot"></span>
        <span class="agent-group-label">${agentType}</span>
        ${description
          ? html`<span class="agent-group-desc">${description}</span>`
          : html`<span class="agent-group-id">${agentId.length > 16 ? agentId.slice(0, 16) + "…" : agentId}</span>`
        }
        <span class="agent-group-count">${events.length} events</span>
      </div>
      ${expanded && html`
        <div class="agent-group-events">
          ${events.map(
            (evt: Event) =>
              html`<${EventCard}
                key=${evt.id}
                event=${evt}
                sessionStart=${sessionStart}
              />`
          )}
        </div>
      `}
    </div>
  `;
}
