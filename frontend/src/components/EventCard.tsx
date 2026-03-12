import { useState } from "preact/hooks";
import { html } from "htm/preact";
import type { Event } from "../../../src/shared/types";
import { renderMarkdown } from "../lib/markdown";
import { computeLineDiff } from "../lib/diff";
import { formatTokenMeta } from "../lib/format";

interface EventCardProps {
  event: Event;
  sessionStart?: string;
}

function formatTime(iso: string, _sessionStart?: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// Try to parse JSON safely
function tryParseJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// Parse metadata from event
function parseMetadata(event: Event): Record<string, unknown> | null {
  return tryParseJson(event.metadata);
}

// Extract file path from tool input preview/data
function extractFilePath(event: Event): string | null {
  const toolsWithPaths = ["Read", "Write", "Edit", "Grep", "Glob"];
  if (!event.tool_name || !toolsWithPaths.includes(event.tool_name)) return null;
  const text = event.input_preview || event.input_data || "";
  // Match file_path or path value in JSON-like strings
  const match = text.match(/file_path["':\s]+["']([^"']{2,})["']/);
  if (match) return match[1];
  const pathMatch = text.match(/["']path["':\s]+["']([^"']{2,})["']/);
  if (pathMatch) return pathMatch[1];
  // Try path-like string (must start with / and have at least one segment)
  const simpleMatch = text.match(/["']?(\/\w[^\s"']+)["']?/);
  return simpleMatch ? simpleMatch[1] : null;
}

// Shorten a file path to filename + parent dir
function shortenPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return fullPath;
  return parts.slice(-2).join('/');
}

// Get a short summary for tool events based on tool-specific input fields
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
      return input.pattern ? `${input.pattern}` : null;
    case "Grep":
      return input.pattern ? `${input.pattern}` : null;
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

// Event type labels for pills
const TYPE_LABELS: Record<string, string> = {
  session_start: "start",
  session_end: "end",
  subagent_start: "agent",
  subagent_end: "agent",
  compaction: "compaction",
  thinking: "thinking",
  assistant_message: "assistant",
  user_message: "user",
  notification: "note",
};

// CSS class for event type pill color
const TYPE_PILL_CLASS: Record<string, string> = {
  session_start: "pill-green",
  session_end: "pill-gray",
  tool_call_start: "pill-tool",
  tool_call_end: "pill-tool",
  subagent_start: "pill-teal",
  subagent_end: "pill-teal",
  compaction: "pill-orange",
  thinking: "pill-yellow",
  assistant_message: "pill-purple",
  user_message: "pill-blue",
  notification: "pill-gray",
};

// Tool-specific badge classes
const TOOL_BADGE_CLASS: Record<string, string> = {
  Read: "tool-read",
  Write: "tool-write",
  Edit: "tool-write",
  Bash: "tool-bash",
  Agent: "tool-agent",
  Grep: "tool-read",
  Glob: "tool-read",
};

// Dot color per event type for the timeline rail
const DOT_COLORS: Record<string, string> = {
  user_message: "#2563eb",
  assistant_message: "var(--accent)",
  tool_call_start: "transparent",
  tool_call_end: "transparent",
  subagent_start: "var(--teal)",
  subagent_end: "var(--teal)",
  compaction: "var(--orange)",
  thinking: "transparent",
  session_start: "var(--green)",
  session_end: "var(--text3)",
  notification: "var(--text3)",
};

const DOT_BORDER_COLORS: Record<string, string> = {
  tool_call_start: "var(--text3)",
  tool_call_end: "var(--text3)",
  thinking: "var(--yellow)",
};

// Event types where we suppress the type pill (dot + card border is enough)
const SUPPRESS_PILL_TYPES = new Set(["assistant_message", "user_message", "thinking"]);

function getDotStyle(eventType: string, isSystemGenerated?: boolean): string {
  if (isSystemGenerated) {
    return `background: var(--bg-muted); border: 1.5px dotted var(--text3);`;
  }
  const bg = DOT_COLORS[eventType] || "var(--text3)";
  const border = DOT_BORDER_COLORS[eventType];
  const isDashed = eventType === "thinking";
  if (border) {
    return `background: ${bg}; border: 1.5px ${isDashed ? 'dashed' : 'solid'} ${border};`;
  }
  return `background: ${bg};`;
}

export function EventCard({ event, sessionStart }: EventCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isToolEvent = event.event_type === "tool_call_start" || event.event_type === "tool_call_end";
  const label = TYPE_LABELS[event.event_type] || event.event_type;
  const pillClass = TYPE_PILL_CLASS[event.event_type] || "pill-gray";
  const typeClass = `event-card event-${event.event_type.replace(/_/g, "-")}`;
  const toolBadgeClass = event.tool_name ? (TOOL_BADGE_CLASS[event.tool_name] || "") : "";

  const meta = parseMetadata(event);
  const isCommand = meta?.command;
  const isSkillExpansion = meta?.subtype === "skill_expansion";
  const isSystemGenerated = meta?.subtype === "system_generated";
  const toolSummary = getToolSummary(event);

  // Expandable: user, assistant, thinking, compaction, and tool events
  const expandableTypes = ["user_message", "assistant_message", "thinking", "compaction", "tool_call_start"];
  const hasExpandable =
    expandableTypes.includes(event.event_type) && (
      event.thinking_text ||
      event.input_data ||
      event.output_data ||
      event.input_preview ||
      event.output_preview
    );

  // Determine extra CSS classes for special message types
  const extraClass = isSkillExpansion ? " event-skill-expansion" : isSystemGenerated ? " event-system-tagged" : "";

  // Change 3: ToolSearch — render as a minimal inline row
  if (event.tool_name === "ToolSearch") {
    const tsInput = tryParseJson(event.input_data);
    const tsQuery = tsInput?.query ? String(tsInput.query) : null;
    return html`
      <div class="toolsearch-inline">
        <div class="event-dot" style=${getDotStyle(event.event_type)}></div>
        <span class="tool-badge">ToolSearch</span>
        ${tsQuery && html`<span class="tool-summary">${truncate(tsQuery, 60)}</span>`}
        ${event.duration_ms != null && html`<span class="event-duration">${formatDuration(event.duration_ms)}</span>`}
      </div>
    `;
  }

  // Change 4: TaskOutput — add task-event class and dot override
  const isTaskOutput = event.tool_name === "TaskOutput";
  const taskClass = isTaskOutput ? " task-event" : "";

  return html`
    <div
      class=${typeClass + (hasExpandable ? " expandable" : "") + extraClass + taskClass}
      onClick=${hasExpandable ? () => setExpanded(!expanded) : undefined}
    >
      <div class=${isTaskOutput ? "event-dot event-dot-task" : "event-dot"} style=${getDotStyle(event.event_type, !!isSystemGenerated)}></div>
      <div class="event-content">
      <div class="event-header">
        <span class="event-time">${formatTime(event.timestamp, sessionStart)}</span>
        ${isCommand && html`<span class="command-pill">${meta.command}</span>`}
        ${isSkillExpansion && html`<span class="event-pill pill-gray">skill</span>`}
        ${isSystemGenerated && html`<span class="event-pill pill-gray">system</span>`}
        ${!isToolEvent && !isCommand && !isSkillExpansion && !isSystemGenerated && !SUPPRESS_PILL_TYPES.has(event.event_type) && html`<span class=${"event-pill " + pillClass}>${label}</span>`}
        ${event.tool_name && html`<span class=${"tool-badge " + toolBadgeClass}>${event.tool_name}</span>`}
        ${isTaskOutput && html`<span class="tool-summary">Sub-agent result</span>`}
        ${toolSummary && html`<span class="tool-summary">${toolSummary}</span>`}
        ${event.event_type === "subagent_start" && event.input_preview && html`<span class="agent-desc">${truncate(event.input_preview, 60)}</span>`}
        ${event.event_type === "thinking" && event.input_tokens != null && html`<span class="event-duration">${event.input_tokens} tokens</span>`}
        ${!toolSummary && (() => { const fp = extractFilePath(event); return fp ? html`<code class="event-file-path" title=${fp}>${shortenPath(fp)}</code>` : null; })()}
        ${event.context_pct != null && event.context_pct >= 50 && html`
          <span class="event-ctx">
            <span class="ctx-minibar">
              <span class="ctx-minibar-fill" style="width: ${Math.min(event.context_pct, 100)}%; background: ${event.context_pct >= 70 ? 'var(--red)' : event.context_pct >= 60 ? 'var(--orange)' : 'var(--yellow)'}"></span>
            </span>
            <span class="mono">${Math.round(event.context_pct)}%</span>
          </span>
        `}
        ${event.duration_ms != null && html`<span class=${"event-duration" + (isTaskOutput && event.duration_ms > 10000 ? " duration-highlight" : "")}>${formatDuration(event.duration_ms)}</span>`}
        ${hasExpandable && html`<span class="event-expand">${expanded ? "▾" : "▸"}</span>`}
      </div>

      ${!expanded && event.event_type === "thinking" && event.thinking_summary && html`
        <div class="event-body event-body-thinking" onClick=${(e: globalThis.Event) => { e.stopPropagation(); setExpanded(!expanded); }}>
          ${event.thinking_summary}
          <div class="fade"></div>
        </div>
      `}

      ${!expanded && event.event_type === "assistant_message" && event.output_preview && html`
        <div class="event-body event-body-assistant markdown-content"
          dangerouslySetInnerHTML=${{ __html: renderMarkdown(event.output_preview) }}
          onClick=${(e: globalThis.Event) => { e.stopPropagation(); setExpanded(!expanded); }}
        />
      `}

      ${!expanded && event.event_type === "user_message" && !isSkillExpansion && !isSystemGenerated && event.input_preview && html`
        <div class="event-body event-body-user" onClick=${(e: globalThis.Event) => { e.stopPropagation(); setExpanded(!expanded); }}>
          ${event.input_preview}
        </div>
      `}

      ${!expanded && event.event_type === "user_message" && isSkillExpansion && html`
        <div class="event-body skill-expansion-body" onClick=${(e: globalThis.Event) => { e.stopPropagation(); setExpanded(!expanded); }}>
          <span class="skill-expansion-label">[skill expansion content]</span>
        </div>
      `}

      ${!expanded && event.event_type === "user_message" && isSystemGenerated && html`
        <div class="event-body event-body-system" onClick=${(e: globalThis.Event) => { e.stopPropagation(); setExpanded(!expanded); }}>
          <span class="system-tag-preview">${event.input_preview}</span>
        </div>
      `}

      ${event.event_type === "compaction" && !expanded && html`
        <div class="compaction-banner">
          <span class="compaction-banner-icon">&#9888;</span>
          <div class="compaction-banner-info">
            <div class="compaction-banner-title">Auto-compaction triggered</div>
            <div class="compaction-banner-desc">
              Context pressure exceeded ${event.context_pct != null ? Math.round(event.context_pct) : "75"}% threshold
            </div>
          </div>
          ${event.input_tokens != null && html`
            <div class="compaction-banner-tokens">
              <div class="compaction-before">${formatTokens(event.input_tokens)} tokens</div>
              ${event.output_tokens != null && html`
                <div class="compaction-after">${formatTokens(event.output_tokens)} tokens</div>
              `}
            </div>
          `}
        </div>
      `}

      ${expanded && html`
        <div class="event-detail">
          ${event.thinking_text && html`
            <div class="detail-section">
              <div class="detail-label">Thinking</div>
              <pre class="detail-content">${event.thinking_text}</pre>
            </div>
          `}
          ${event.event_type === "tool_call_start" && event.tool_name === "Edit" && (() => {
            const input = tryParseJson(event.input_data);
            if (!input?.old_string) return null;
            const diffLines = computeLineDiff(String(input.old_string), String(input.new_string || ""));
            return html`
              <div class="detail-section">
                <div class="detail-label">Edit: ${input.file_path || ""}</div>
                <div class="diff-view">
                  ${diffLines.map((line) => html`
                    <div class=${"diff-line diff-line-" + line.type}>
                      <span class="diff-line-prefix">${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
                      <span class="diff-line-text">${line.text}</span>
                    </div>
                  `)}
                </div>
              </div>
            `;
          })()}
          ${event.event_type === "tool_call_start" && event.tool_name !== "Edit" && event.input_data && html`
            <div class="detail-section">
              <div class="detail-label">Input</div>
              <pre class="detail-content">${event.input_data}</pre>
            </div>
          `}
          ${event.event_type !== "tool_call_start" && event.input_preview && html`
            <div class="detail-section">
              <div class="detail-label">Input</div>
              <pre class="detail-content">${event.input_data || event.input_preview}</pre>
            </div>
          `}
          ${event.output_preview && event.event_type === "assistant_message" && html`
            <div class="detail-section">
              <div class="detail-label">Output</div>
              <div class="detail-content markdown-content"
                dangerouslySetInnerHTML=${{ __html: renderMarkdown(event.output_data || event.output_preview) }}
              />
            </div>
          `}
          ${event.output_preview && event.event_type !== "assistant_message" && !(event.tool_name === "Edit" && /has been (updated|created) successfully/.test(event.output_preview || "")) && html`
            <div class="detail-section">
              <div class="detail-label">Output</div>
              <pre class="detail-content">${event.output_data || event.output_preview}</pre>
            </div>
          `}
          ${(() => {
            const tokenStr = formatTokenMeta(event.input_tokens ?? null, event.output_tokens ?? null, event.cache_read_tokens ?? null);
            return tokenStr ? html`
              <div class="detail-section detail-tokens">
                <span>${tokenStr}</span>
              </div>
            ` : null;
          })()}
        </div>
      `}
      </div>
    </div>
  `;
}
