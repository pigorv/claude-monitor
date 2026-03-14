import { useState, useMemo } from "preact/hooks";
import { html } from "htm/preact";
import type { Event } from "../../../src/shared/types";

interface AgentGroupProps {
  agentId: string;
  events: Event[];
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

export function AgentGroup({ agentId, events, sessionStart, agentDescription }: AgentGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<number, boolean>>({});
  const [expandedBodies, setExpandedBodies] = useState<Record<number, boolean>>({});
  const [expandedIo, setExpandedIo] = useState<Record<string, boolean>>({});

  // Extract metadata from events
  const meta = useMemo(() => {
    let description = agentDescription || null;
    let agentStartMs = 0;
    let durationMs = 0;
    let totalTokens = 0;
    let status: "completed" | "running" | "failed" = "running";

    // Find description from Agent/Task tool call
    for (const evt of events) {
      if (evt.event_type === "tool_call_start" && (evt.tool_name === "Agent" || evt.tool_name === "Task")) {
        if (!description) {
          const input = tryParseJson(evt.input_data);
          if (input?.description) description = String(input.description);
        }
      }
    }

    // Compute timing and tokens
    if (events.length > 0) {
      agentStartMs = new Date(events[0].timestamp).getTime();
      const lastEvt = events[events.length - 1];
      const endMs = new Date(lastEvt.timestamp).getTime();
      durationMs = endMs - agentStartMs;
    }

    for (const evt of events) {
      totalTokens += (evt.input_tokens || 0) + (evt.output_tokens || 0);
      if (evt.event_type === "subagent_end") status = "completed";
    }

    return { description, agentStartMs, durationMs, totalTokens, status };
  }, [events, agentDescription]);

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
    // Strip markdown headings and numbered lists
    const cleaned = text
      .replace(/^#{1,4}\s+.*/gm, "")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/```[\s\S]*?```/g, "")
      .trim();
    const firstSentence = cleaned.match(/^[^.!?\n]{10,120}[.!?]?/);
    return firstSentence ? firstSentence[0].trim() : cleaned.slice(0, 100);
  };

  const shortId = agentId.length > 16 ? agentId.slice(0, 16) : agentId;

  return html`
    <div class="agent-block">
      <div class="agent-block-header" onClick=${() => setExpanded(!expanded)}>
        <span class="agent-block-caret">${expanded ? "▾" : "▸"}</span>
        <span class="agent-block-dot"></span>
        <span class="agent-block-id">${shortId}</span>
        ${meta.description
          ? html`<span class="agent-block-desc">${meta.description}</span>`
          : null
        }
        <span class="agent-block-meta">
          <span>${events.length} events</span>
          ${meta.durationMs > 0 && html`<span>${formatDuration(meta.durationMs)}</span>`}
          ${meta.totalTokens > 0 && html`<span>${formatTokens(meta.totalTokens)} tok</span>`}
          <span class=${"agent-block-status " + meta.status}>${meta.status}</span>
        </span>
      </div>
      <div class=${"agent-block-body" + (expanded ? " show" : "")}>
        <div class="agent-events">
          ${events.map((evt: Event) => {
            const isToolCall = evt.event_type === "tool_call_start";
            const isAssistant = evt.event_type === "assistant_message";
            const isUser = evt.event_type === "user_message";
            const offset = formatOffset(evt.timestamp);

            // Tool call events — expandable with I/O detail
            if (isToolCall && evt.tool_name) {
              const filePath = extractFilePath(evt);
              const tokenCount = (evt.input_tokens || 0) + (evt.output_tokens || 0);
              const isHeavy = (evt.output_tokens || 0) > 1000;
              const toolClass = TOOL_BADGE_CLASS[evt.tool_name] || "";
              const isOpen = expandedTools[evt.id] || false;

              return html`
                <div class="agent-event agent-event-expandable" onClick=${() => toggleTool(evt.id)}>
                  <div class="mini-dot tool"></div>
                  <div class="agent-event-header">
                    <span class="agent-event-time">${offset}</span>
                    <span class=${"tool-badge " + toolClass}>${evt.tool_name}</span>
                    ${filePath && html`<code style="font-family:var(--mono);font-size:10px;color:var(--text2);background:var(--bg-muted);padding:1px 5px;border-radius:3px">${shortenPath(filePath)}</code>`}
                    ${tokenCount > 0 && html`<span style="font-size:10px;font-family:var(--mono);color:var(--text3)">${formatTokens(tokenCount)} tok</span>`}
                    <span class="agent-event-expand-caret">${isOpen ? "▾" : "▸"}</span>
                  </div>
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
                      <div class="agent-tool-io-label">Output</div>
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
            }

            // Assistant message — compact body with purple mini-dot
            if (isAssistant) {
              const body = evt.output_preview || evt.output_data || "";
              const isBodyOpen = expandedBodies[evt.id] || false;
              return html`
                <div class="agent-event">
                  <div class="mini-dot assistant"></div>
                  <div class="agent-event-header">
                    <span class="agent-event-time">${offset}</span>
                    <span style="font-size:10px;color:var(--accent);font-weight:500">assistant</span>
                  </div>
                  ${body && html`
                    <div class=${"agent-event-body assistant-nested" + (isBodyOpen ? " expanded" : "")} onClick=${() => toggleBody(evt.id)}>
                      ${body}
                      <div class="fade"></div>
                    </div>
                  `}
                </div>
              `;
            }

            // User message (orchestrator prompt) — muted with summary
            if (isUser) {
              const rawText = evt.input_preview || evt.input_data || "";
              const summary = parsePromptSummary(rawText);
              const isBodyOpen = expandedBodies[evt.id] || false;
              return html`
                <div class="agent-event">
                  <div class="mini-dot user"></div>
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

            // Other events (thinking, subagent_start/end, etc.) — generic compact row
            return html`
              <div class="agent-event">
                <div class="mini-dot"></div>
                <div class="agent-event-header">
                  <span class="agent-event-time">${offset}</span>
                  <span style="font-size:10px;color:var(--text3)">${evt.event_type.replace(/_/g, " ")}</span>
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}
