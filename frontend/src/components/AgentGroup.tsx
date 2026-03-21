import { useState, useMemo, useEffect } from "preact/hooks";
import { html } from "htm/preact";
import { fetchEvents } from "../api/client";
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

function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return fullPath;
  return parts.slice(-2).join('/');
}

function extractFilePath(event: Event): string | null {
  const text = event.input_preview || event.input_data || "";
  const match = text.match(/file_path["':\s]+["']([^"']{2,})["']/);
  if (match) return match[1];
  const pathMatch = text.match(/["']path["':\s]+["']([^"']{2,})["']/);
  if (pathMatch) return pathMatch[1];
  const simpleMatch = text.match(/["']?(\/\w[^\s"']+)["']?/);
  return simpleMatch ? simpleMatch[1] : null;
}

// Tool badge color classes
const TOOL_BADGE_CLASS: Record<string, string> = {
  Read: "tool-read", Write: "tool-write", Edit: "tool-write",
  Bash: "tool-bash", Agent: "tool-agent", Grep: "tool-read", Glob: "tool-read",
};

const TOOL_TRUNCATE_THRESHOLD = 5;
const TOOL_SHOW_INITIAL = 3;

export function AgentGroup({ agentId, sessionId, agent, events: propEvents, sessionStart, agentDescription }: AgentGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});
  const [expandedBodies, setExpandedBodies] = useState<Record<number, boolean>>({});
  const [expandedIo, setExpandedIo] = useState<Record<string, boolean>>({});
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

      // Compute read output tokens and last assistant from events (when loaded)
      let totalReadOutputTokens = 0;
      let lastAssistantId: number | null = null;
      for (const evt of events) {
        if (evt.event_type === "tool_call_start" && evt.tool_name === "Read") {
          totalReadOutputTokens += (evt.output_tokens || 0);
        }
      }
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].event_type === "assistant_message") {
          lastAssistantId = events[i].id;
          break;
        }
      }

      const agentStartMs = agent.started_at ? new Date(agent.started_at).getTime() : 0;
      return { description, agentStartMs, durationMs, totalTokens, totalReadOutputTokens, status, lastAssistantId, eventCount: agent.tool_call_count || events.length };
    }

    // Fallback: compute from events (legacy path)
    let agentStartMs = 0;
    let durationMs = 0;
    let totalTokens = 0;
    let totalReadOutputTokens = 0;
    let status: "completed" | "running" | "failed" = "running";

    if (events.length > 0) {
      agentStartMs = new Date(events[0].timestamp).getTime();
      const lastEvt = events[events.length - 1];
      durationMs = new Date(lastEvt.timestamp).getTime() - agentStartMs;
    }

    let lastAssistantId: number | null = null;
    for (const evt of events) {
      totalTokens += (evt.input_tokens || 0) + (evt.output_tokens || 0);
      if (evt.event_type === "subagent_end") status = "completed";
      if (evt.event_type === "tool_call_start" && evt.tool_name === "Read") {
        totalReadOutputTokens += (evt.output_tokens || 0);
      }
    }
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].event_type === "assistant_message") {
        lastAssistantId = events[i].id;
        break;
      }
    }

    return { description, agentStartMs, durationMs, totalTokens, totalReadOutputTokens, status, lastAssistantId, eventCount: events.length };
  }, [events, agent, agentDescription]);

  const toggleTool = (id: number) => {
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleBody = (id: number) => {
    setExpandedBodies((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const toggleIo = (key: string) => {
    setExpandedIo((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const formatOffset = (timestamp: string): string => {
    const ms = new Date(timestamp).getTime() - meta.agentStartMs;
    if (ms <= 0) return "+0.0s";
    return `+${(ms / 1000).toFixed(1)}s`;
  };

  // Parse first meaningful sentence from orchestrator prompt
  const parsePromptSummary = (text: string): string => {
    const cleaned = text
      .replace(/^#{1,4}\s+.*/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/```[\s\S]*?```/g, "")
      .trim();
    const firstSentence = cleaned.match(/^[^.!?\n]{10,120}[.!?]?/);
    return firstSentence ? firstSentence[0].trim() : cleaned.slice(0, 100);
  };

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

  const renderToolEvent = (evt: Event) => {
    const filePath = extractFilePath(evt);
    const tokenCount = (evt.input_tokens || 0) + (evt.output_tokens || 0);
    const isHeavy = (evt.output_tokens || 0) > 1000;
    const toolClass = TOOL_BADGE_CLASS[evt.tool_name || ""] || "";
    const isOpen = expandedTools[evt.id] || false;

    // Token percentage for Read tools (#5)
    const readPct = evt.tool_name === "Read" && meta.totalReadOutputTokens > 0 && (evt.output_tokens || 0) > 0
      ? Math.round(((evt.output_tokens || 0) / meta.totalReadOutputTokens) * 100)
      : 0;

    return html`
      <div class="agent-tool-row" onClick=${() => toggleTool(evt.id)}>
        <div class="mini-dot tool"></div>
        <span class=${"tool-badge " + toolClass}>${evt.tool_name}</span>
        ${filePath && html`<span class="tool-path">${shortenPath(filePath)}</span>`}
        ${tokenCount > 0 && html`<span class=${"tool-tokens" + (isHeavy ? " heavy" : "")}>${formatTokens(tokenCount)} tok</span>`}
        <span class="tool-expand-caret">${isOpen ? "▾" : "▸"}</span>
      </div>
      <div class=${"agent-tool-detail" + (isOpen ? " show" : "")}>
        ${evt.input_data && html`
          <div class="agent-tool-io">
            <div class="agent-tool-io-label">Input</div>
            <div class=${"agent-tool-io-content" + (expandedIo["in-" + evt.id] ? " expanded" : "")} onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleIo("in-" + evt.id); }}>
              ${evt.input_data}
              <div class="fade"></div>
            </div>
          </div>
        `}
        ${(evt.output_data || evt.output_preview) && html`
          <div class="agent-tool-io">
            <div class="agent-tool-io-label">Output${readPct >= 20 ? html` <span style="font-size:7px;color:var(--orange);font-weight:600;margin-left:3px">${readPct}% of agent reads</span>` : ""}</div>
            <div class=${"agent-tool-io-content" + (expandedIo["out-" + evt.id] ? " expanded" : "")} onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleIo("out-" + evt.id); }}>
              ${evt.output_data || evt.output_preview}
              <div class="fade"></div>
            </div>
          </div>
        `}
        <div class="agent-tool-tokens">
          ${evt.output_tokens != null && html`<span>output: <span class=${"val" + (isHeavy ? " heavy" : "")}>${formatTokens(evt.output_tokens)} tokens</span></span>`}
          ${evt.cache_read_tokens != null && evt.cache_read_tokens > 0 && html`<span>cache: <span class="val">${formatTokens(evt.cache_read_tokens)}</span></span>`}
          ${evt.duration_ms != null && html`<span>${formatDuration(evt.duration_ms)}</span>`}
        </div>
      </div>
    `;
  };

  const renderNonToolEvent = (evt: Event) => {
    const isAssistant = evt.event_type === "assistant_message";
    const isUser = evt.event_type === "user_message";
    const offset = formatOffset(evt.timestamp);

    // Agent result: last assistant message (#7)
    if (isAssistant) {
      const isResult = evt.id === meta.lastAssistantId;
      const body = evt.output_data || evt.output_preview || "";
      const isBodyOpen = expandedBodies[evt.id] || false;
      return html`
        <div class="agent-event">
          <div class="mini-dot assistant"></div>
          <div class="agent-event-header">
            <span class="agent-event-time">${offset}</span>
            ${isResult
              ? html`
                <span style="font-size:10px;color:var(--teal);font-weight:500">result</span>
                ${meta.totalTokens > 0 && html`<span style="font-size:10px;font-family:var(--mono);color:var(--text3)">${formatTokens(meta.totalTokens)} tok</span>`}
              `
              : html`<span style="font-size:10px;color:var(--accent);font-weight:500">assistant</span>`
            }
          </div>
          ${body && html`
            <div class=${"agent-event-body" + (isResult ? " result-body" : " assistant-nested") + (isBodyOpen ? " expanded" : "")} onClick=${() => toggleBody(evt.id)}>
              ${body}
              <div class="fade"></div>
            </div>
          `}
        </div>
      `;
    }

    if (isUser) {
      const rawText = evt.input_preview || evt.input_data || "";
      const summary = parsePromptSummary(rawText);
      const isBodyOpen = expandedBodies[evt.id] || false;
      return html`
        <div class="agent-event">
          <div class="mini-dot"></div>
          <div class="agent-event-header">
            <span class="agent-event-time">${offset}</span>
            <span style="font-size:10px;color:var(--text3);font-weight:500;font-style:italic">prompt</span>
          </div>
          <div class=${"agent-event-body prompt-muted" + (isBodyOpen ? " expanded" : "")} onClick=${() => toggleBody(evt.id)}>
            ${summary}
            <div class="fade"></div>
          </div>
        </div>
      `;
    }

    // Other events (thinking, etc.) — generic compact row
    return html`
      <div class="agent-event">
        <div class="mini-dot"></div>
        <div class="agent-event-header">
          <span class="agent-event-time">${offset}</span>
          <span style="font-size:10px;color:var(--text3)">${evt.event_type.replace(/_/g, " ")}</span>
        </div>
      </div>
    `;
  };

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
        ${loadingEvents && html`<div style="padding:8px 12px;font-size:12px;color:var(--text3)">Loading agent events…</div>`}
        <div class="agent-events">
          ${renderEvents.map((chunk) => {
            if (chunk.type === "single") {
              return renderNonToolEvent(chunk.evt);
            }
            // Tool chunk with truncation (#4)
            const tools = chunk.events;
            const canTruncate = tools.length > TOOL_TRUNCATE_THRESHOLD;
            const visibleTools = canTruncate && !showAllTools ? tools.slice(0, TOOL_SHOW_INITIAL) : tools;
            const hiddenCount = tools.length - TOOL_SHOW_INITIAL;

            return html`
              ${visibleTools.map((evt) => renderToolEvent(evt))}
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
