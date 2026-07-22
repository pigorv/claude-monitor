import { useState } from "preact/hooks";
import { html } from "htm/preact";
import type { Event } from "../../../src/shared/types";
import { renderMarkdown } from "../lib/markdown";
import { StructuredContent } from "./StructuredContent";
import { CopyButton } from "./CopyButton";
import { compactionDescription } from "./CompactionBanner";
import { computeLineDiff, type DiffLine } from "../lib/diff";
import { formatTokenMeta, formatTokenCount } from "../lib/format";
import { hasNonEmptySelection } from "../lib/selection";
import {
  type AskQuestion,
  type AskAnswerValue,
  parseAskOutput,
  normalizeAnswerValues,
  formatAskQuestionForCopy,
} from "../lib/ask-output";
import { highlight } from "../lib/syntax";
import { toolTagClass } from "../lib/tool-tags";

interface EventCardProps {
  event: Event;
  sessionStart?: string;
  groupIndex?: number;
  rationale?: string;
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// True when the user has an active text selection. Used to suppress the
// expand/collapse toggle so a drag-select's trailing `click` doesn't collapse
// the block out from under the selection (issue #47). The decision logic is
// in lib/selection.ts so it can be unit-tested without a DOM environment.
function hasTextSelection(): boolean {
  return hasNonEmptySelection(window.getSelection()?.toString());
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
  const match = text.match(/file_path["':\s]+["']([^"']{2,})["']/);
  if (match) return match[1];
  const pathMatch = text.match(/["']path["':\s]+["']([^"']{2,})["']/);
  if (pathMatch) return pathMatch[1];
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
    case "Write":
    case "Edit":
      return input.file_path ? shortenPath(String(input.file_path)) : null;
    case "TaskCreate":
      return input.subject ? truncate(String(input.subject), 60) : null;
    case "TaskUpdate": {
      const id = input.taskId || input.task_id || "?";
      const status = input.status || "unknown";
      return `#${id} → ${status}`;
    }
    case "ToolSearch":
      return input.query ? String(input.query) : (input.tool_name ? String(input.tool_name) : null);
    case "WebFetch":
      return input.url ? truncate(String(input.url), 60) : null;
    case "AskUserQuestion": {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      const first = qs[0] && typeof qs[0] === "object" ? (qs[0] as Record<string, unknown>) : null;
      const text = first && typeof first.question === "string" ? first.question : null;
      if (!text) return null;
      return qs.length > 1 ? `${truncate(text, 50)} (+${qs.length - 1})` : truncate(text, 60);
    }
    default:
      return (input.file_path ? shortenPath(String(input.file_path)) : null)
        || (input.command ? truncate(String(input.command), 60) : null)
        || (input.subject ? truncate(String(input.subject), 60) : null)
        || (input.query ? String(input.query) : null)
        || null;
  }
}

// Detect partial Read tool call (has offset or limit params)
function isPartialRead(event: Event): boolean {
  if (event.tool_name !== "Read") return false;
  const input = tryParseJson(event.input_data);
  if (!input) return false;
  return input.offset != null || input.limit != null;
}

// Extract TaskUpdate status for color-coded rendering
function getTaskUpdateInfo(event: Event): { taskId: string; status: string } | null {
  if (event.tool_name !== "TaskUpdate") return null;
  const input = tryParseJson(event.input_data);
  if (!input) return null;
  const id = String(input.taskId || input.task_id || "?");
  const status = String(input.status || "unknown");
  return { taskId: id, status };
}

// Strip ANSI escape codes
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*m/g, '');
}

// Parse /context output into structured data
interface ContextRow { label: string; tokens: string; pct: string; pctNum: number; }
interface ContextData { model: string; summary: string; rows: ContextRow[]; }

function parseContextOutput(raw: string): ContextData | null {
  const text = stripAnsi(raw);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Look for model line (e.g., "Model: claude-opus-4-6")
  let model = '';
  const modelMatch = text.match(/Model:\s*(\S+)/i);
  if (modelMatch) model = modelMatch[1];

  // Look for summary line (e.g., "33k / 1000k tokens (3.3%)")
  let summary = '';
  const summaryMatch = text.match(/(\d[\d,.]*k?\s*\/\s*\d[\d,.]*k?\s*tokens?\s*\([\d.]+%\))/i);
  if (summaryMatch) summary = summaryMatch[1];

  // Parse rows: look for lines like "System prompt    5.6k    0.6%"
  const rows: ContextRow[] = [];
  const rowPattern = /^(.+?)\s{2,}([\d,.]+k?)\s+([\d.]+%)/;
  for (const line of lines) {
    const m = line.match(rowPattern);
    if (m) {
      const pctStr = m[3].replace('%', '');
      rows.push({
        label: m[1].trim(),
        tokens: m[2].trim(),
        pct: m[3].trim(),
        pctNum: parseFloat(pctStr) || 0,
      });
    }
  }

  if (rows.length === 0) return null;
  return { model, summary, rows };
}

// Command deduplication: returns args to show, or null if body equals command name
function getCommandArgs(meta: Record<string, unknown>): string | null {
  const args = (meta.command_args as string) || '';
  return args || null;
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
  session_start: "pill-teal",
  session_end: "pill-gray",
  tool_call_start: "pill-tool",
  tool_call_end: "pill-tool",
  subagent_start: "pill-teal",
  subagent_end: "pill-teal",
  compaction: "pill-amber",
  thinking: "pill-amber",
  assistant_message: "pill-gray",
  user_message: "pill-purple",
  notification: "pill-gray",
};

// Dot color per event type for the timeline rail
const DOT_COLORS: Record<string, string> = {
  user_message: "var(--color-interactive-selected-text)",
  assistant_message: "var(--color-text-secondary)",
  tool_call_start: "transparent",
  tool_call_end: "transparent",
  subagent_start: "var(--color-status-completed)",
  subagent_end: "var(--color-status-completed)",
  compaction: "var(--color-status-warning-text)",
  thinking: "transparent",
  session_start: "var(--color-status-completed)",
  session_end: "var(--color-text-tertiary)",
  notification: "var(--color-text-tertiary)",
};

const DOT_BORDER_COLORS: Record<string, string> = {
  tool_call_start: "var(--color-text-tertiary)",
  tool_call_end: "var(--color-text-tertiary)",
  thinking: "var(--color-status-warning-text)",
};

// Event types where we suppress the type pill. User/assistant now show an
// uppercase role label (USER / ASSISTANT); thinking keeps its own treatment.
const SUPPRESS_PILL_TYPES = new Set(["thinking"]);

function getDotStyle(eventType: string, isSystemGenerated?: boolean, isSkillExpansion?: boolean): string {
  if (isSystemGenerated) {
    return `background: var(--color-background-tertiary); border: 1.5px dotted var(--color-text-tertiary);`;
  }
  if (isSkillExpansion) {
    return `background: transparent; border: 2px dashed var(--color-interactive-selected-text);`;
  }
  const bg = DOT_COLORS[eventType] || "var(--color-text-tertiary)";
  const border = DOT_BORDER_COLORS[eventType];
  const isDashed = eventType === "thinking";
  if (border) {
    return `background: ${bg}; border: 1.5px ${isDashed ? 'dashed' : 'solid'} ${border};`;
  }
  return `background: ${bg};`;
}

// Derive a human-readable language label from a file extension.
function detectLanguage(filePath: string | null): string {
  if (!filePath) return "Text";
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    mjs: "JavaScript", cjs: "JavaScript",
    py: "Python", rb: "Ruby", go: "Go", rs: "Rust",
    java: "Java", kt: "Kotlin", swift: "Swift",
    c: "C", h: "C", cc: "C++", cpp: "C++", hpp: "C++",
    cs: "C#", php: "PHP",
    json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML",
    md: "Markdown", mdx: "Markdown", html: "HTML", htm: "HTML",
    css: "CSS", scss: "SCSS",
    sql: "SQL", sh: "Shell", bash: "Shell", zsh: "Shell", fish: "Shell",
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : "Text");
}

// Trim a diff to the first `maxLines` lines, preserving up to `leadingContext`
// unchanged lines before the first change. Returns the lines to render and
// how many were hidden.
function previewDiff(
  diff: DiffLine[],
  maxLines = 24,
  leadingContext = 8,
): { lines: DiffLine[]; hidden: number } {
  const firstChange = diff.findIndex((l) => l.type !== "unchanged");
  const start = firstChange < 0 ? 0 : Math.max(0, firstChange - leadingContext);
  const slice = diff.slice(start, start + maxLines);
  return { lines: slice, hidden: Math.max(0, diff.length - slice.length) };
}

// Check if a tool event has an error (works for all tool types)
function isToolErrorEvent(event: Event): boolean {
  const meta = parseMetadata(event);
  if (meta?.tool_error) return true;
  if (meta?.permission_status === "rejected") return true;
  const output = event.output_data || "";
  const exitMatch = output.match(/"exit_code"\s*:\s*(\d+)/);
  if (exitMatch && exitMatch[1] !== "0") return true;
  return false;
}

export function EventCard({ event, sessionStart, groupIndex, rationale }: EventCardProps) {
  const [expanded, setExpanded] = useState(false);
  // Per-question L3 expansion for AskUserQuestion cards. Each question expands
  // independently — multiple can be open at once. Unused for any other event type.
  const [expandedQs, setExpandedQs] = useState<Set<number>>(new Set());
  const toggleQ = (i: number) => setExpandedQs((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  // Toggle expand/collapse, but skip it when the user has a text selection —
  // otherwise the trailing `click` of a drag-select collapses the block and
  // discards the selection (issue #47).
  const toggleExpand = () => { if (!hasTextSelection()) setExpanded((v) => !v); };

  // Swallow clicks inside an expanded detail pane so they never reach the
  // card's expand/collapse toggle. The selection-guard alone isn't enough:
  // the leading single-click of a double/triple-click word-select fires
  // before any selection exists. Collapse stays available via the header
  // chevron, which lives outside these panes (issue #47).
  const stopToggle = (e: globalThis.Event) => e.stopPropagation();

  // Explicit collapse control rendered at the foot of each expanded pane.
  // Since clicks inside the pane no longer collapse it (so selection works),
  // this is the discoverable way back — the header chevron also still works.
  const collapseFooter = html`
    <button type="button" class="collapse-btn" onClick=${() => setExpanded(false)}>
      <span class="collapse-btn-icon">▴</span> Collapse
    </button>
  `;

  // Header row for an expanded detail section: the label plus a hover-revealed
  // Copy button that puts the full, untruncated raw text on the clipboard.
  const sectionHeader = (labelText: string, copyText: string | null | undefined) => html`
    <div class="detail-section-header">
      ${copyText && html`<${CopyButton} text=${copyText} />`}
      <div class="detail-label">${labelText}</div>
    </div>
  `;

  const isToolEvent = event.event_type === "tool_call_start" || event.event_type === "tool_call_end";
  const label = TYPE_LABELS[event.event_type] || event.event_type;
  const isRoleMsg = event.event_type === "user_message" || event.event_type === "assistant_message";
  const pillClass = TYPE_PILL_CLASS[event.event_type] || "pill-gray";
  const typeClass = `event-card event-${event.event_type.replace(/_/g, "-")}`;
  const toolBadgeClass = event.tool_name ? toolTagClass(event.tool_name) : "";

  const meta = parseMetadata(event);
  const isCommand = meta?.command;
  const isSkillExpansion = meta?.subtype === "skill_expansion";
  const skillName = isSkillExpansion ? (meta?.skill_name as string || null) : null;
  const isSystemGenerated = meta?.subtype === "system_generated";
  const isRejected = meta?.permission_status === "rejected";
  const isToolError = meta?.tool_error === true;
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

  // System-generated messages → inline muted row
  if (event.event_type === 'user_message' && isSystemGenerated && !isCommand) {
    const isContextOutput = meta?.context_output === true;
    const contextData = isContextOutput ? parseContextOutput(event.input_data || event.input_preview || '') : null;

    return html`
      <div class="event-card event-user-message">
        <div class="event-dot dot-sys"></div>
        <div class="event-content">
          <div class="sys-row" onClick=${toggleExpand}>
            <span class="sys-label">system</span>
            <span class="sys-text">${contextData ? 'Context usage output' : truncate(event.input_preview || '[system message]', 80)}</span>
            <span class="sys-expand">${expanded ? '▾' : '›'}</span>
          </div>
          ${expanded && !contextData && html`
            <div class="sys-expanded" onClick=${stopToggle}>
              ${StructuredContent({ text: event.input_data || event.input_preview, hint: "markdown" })}
              ${collapseFooter}
            </div>
          `}
          ${contextData && html`
            <div class="ctx-card">
              <div class="ctx-header">
                <div class="ctx-header-title">Context usage</div>
                <div class="ctx-header-meta">${contextData.model}${contextData.summary ? ` · ${contextData.summary}` : ''}</div>
              </div>
              ${contextData.rows.map(row => html`
                <div class=${"ctx-row" + (row.label.toLowerCase().includes('autocompact') || row.label.toLowerCase().includes('total') ? ' ctx-row-total' : '')}>
                  <span class="ctx-row-label">${row.label}</span>
                  <span class="ctx-row-right">
                    <span class="ctx-val">${row.tokens}</span>
                    <span class="ctx-pct">${row.pct}</span>
                    <span class="ctx-bar">
                      <span class=${"ctx-fill" + (row.label.toLowerCase().includes('free') ? ' ctx-fill-green' : '')}
                        style=${"width: " + Math.min(row.pctNum, 100) + "%;"}></span>
                    </span>
                  </span>
                </div>
              `)}
            </div>
          `}
        </div>
      </div>
    `;
  }

  // Interrupted assistant message → amber style
  if (event.event_type === 'assistant_message' && (meta?.subtype === 'interrupted' || (event.output_preview || '').includes('[Request interrupted'))) {
    return html`
      <div class="event-card event-assistant-message">
        <div class="event-dot dot-interrupt"></div>
        <div class="event-content">
          <div class="event-header">
            <span class="event-time">${formatTime(event.timestamp, sessionStart)}</span>
          </div>
          <div class="event-body msg msg-interrupt">${event.output_preview || '[Request interrupted by user]'}</div>
        </div>
      </div>
    `;
  }

  // "No response requested" → muted inline
  if (event.event_type === 'assistant_message' && (meta?.subtype === 'no_response' || (event.output_preview || '').trim() === 'No response requested.')) {
    return html`
      <div class="event-card event-assistant-message">
        <div class="event-dot dot-muted"></div>
        <div class="event-content">
          <div class="event-header">
            <span class="event-time">${formatTime(event.timestamp, sessionStart)}</span>
          </div>
          <div class="event-body msg msg-muted">No response requested.</div>
        </div>
      </div>
    `;
  }

  // ToolSearch — render as a minimal inline row
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

  // Write/Edit — new full-card render with rationale + meta pill + collapsible body.
  if (event.event_type === "tool_call_start" && (event.tool_name === "Write" || event.tool_name === "Edit")) {
    const isErr = isToolErrorEvent(event);
    const input = tryParseJson(event.input_data) ?? {};
    const filePath = typeof input.file_path === "string" ? input.file_path : null;
    const lang = detectLanguage(filePath);

    // Header meta-pill parts
    const metaParts: string[] = [lang];
    if (event.duration_ms != null) metaParts.push(formatDuration(event.duration_ms));
    const outStr = formatTokenCount(event.output_tokens ?? null);
    if (outStr) metaParts.push(`out: ${outStr}`);
    const cacheStr = formatTokenCount(event.cache_read_tokens ?? null);
    if (cacheStr) metaParts.push(`cache: ${cacheStr}`);

    // Body
    const isWrite = event.tool_name === "Write";
    const writeContent = isWrite && typeof input.content === "string" ? input.content : "";
    const writeLines = isWrite ? writeContent.split("\n") : [];
    const editDiff: DiffLine[] = !isWrite && typeof input.old_string === "string"
      ? computeLineDiff(String(input.old_string), String(input.new_string ?? ""))
      : [];
    const PREVIEW_LINES = 10;
    const EDIT_LEADING_CONTEXT = 3;
    const writePreview = isWrite ? writeLines.slice(0, PREVIEW_LINES) : [];
    const writeHidden = isWrite ? Math.max(0, writeLines.length - writePreview.length) : 0;
    const editPreview = !isWrite ? previewDiff(editDiff, PREVIEW_LINES, EDIT_LEADING_CONTEXT) : { lines: [], hidden: 0 };
    const hidden = isWrite ? writeHidden : editPreview.hidden;

    // Copy target: full file content for Write, the new text for Edit
    // (falling back to old_string so pure-deletion Edits still expose a Copy button).
    const mutatingCopyText = isWrite
      ? writeContent
      : (String(input.new_string ?? "") || String(input.old_string ?? ""));

    // Rationale: truncate to 240 chars; track separate expand state.
    const RAT_MAX = 240;
    const ratLong = rationale != null && rationale.length > RAT_MAX;

    const cardClass = "event-card event-card-mutating"
      + (isWrite ? " event-card-write" : " event-card-edit")
      + (isErr ? " event-card-mutating-error" : "");

    return html`
      <div class=${cardClass}>
        <div class=${"event-dot dot-tool" + (isErr ? " dot-tool-err" : "")}></div>
        <div class="event-content">
          <div class="event-card-mutating-header">
            <div class="event-card-mutating-header-left">
              ${groupIndex != null && html`<span class="tg-item-badge">#${groupIndex}</span>`}
              <span class=${"tool-badge " + toolBadgeClass}>${event.tool_name}</span>
              ${filePath && html`<span class="event-card-mutating-path" title=${filePath}>${shortenPath(filePath)}</span>`}
              ${isErr && isRejected && html`<span class="permission-badge rejected">rejected</span>`}
              ${isErr && !isRejected && html`<span class="err-badge">error</span>`}
            </div>
            <div class="event-card-meta-pill">${metaParts.join(" · ")}</div>
            <${CopyButton} text=${mutatingCopyText} />
          </div>

          ${rationale && html`
            <div class="event-card-rationale-row">
              <div class="event-card-rationale">
                ${ratLong && !expanded
                  ? html`<span>${truncate(rationale, RAT_MAX)}</span><span class="event-card-more-lines" onClick=${(e: globalThis.Event) => { e.stopPropagation(); setExpanded(true); }}> [▸ expand]</span>`
                  : html`<span>${rationale}</span>`
                }
              </div>
              ${event.context_pct != null && event.context_pct >= 50 && html`
                <span class="event-ctx">
                  <span class="ctx-minibar">
                    <span class="ctx-minibar-fill" style="width: ${Math.min(event.context_pct, 100)}%; background: ${event.context_pct >= 70 ? 'var(--color-status-danger-text)' : 'var(--color-status-warning-text)'}"></span>
                  </span>
                  <span class="mono">${Math.round(event.context_pct)}%</span>
                </span>
              `}
            </div>
          `}

          ${!rationale && event.context_pct != null && event.context_pct >= 50 && html`
            <div class="event-card-rationale-row event-card-rationale-row-ctx-only">
              <span class="event-ctx">
                <span class="ctx-minibar">
                  <span class="ctx-minibar-fill" style="width: ${Math.min(event.context_pct, 100)}%; background: ${event.context_pct >= 70 ? 'var(--color-status-danger-text)' : 'var(--color-status-warning-text)'}"></span>
                </span>
                <span class="mono">${Math.round(event.context_pct)}%</span>
              </span>
            </div>
          `}

          <div class="event-card-body">
            ${isWrite
              ? html`
                <div class="diff-view">
                  ${(expanded ? writeLines : writePreview).map((text) => html`
                    <div class="diff-line">
                      <span class="diff-line-text" dangerouslySetInnerHTML=${{ __html: highlight(text, lang) }}></span>
                    </div>
                  `)}
                </div>
              `
              : html`
                <div class="diff-view">
                  ${(expanded ? editDiff : editPreview.lines).map((line) => html`
                    <div class=${"diff-line diff-line-" + line.type}>
                      <span class="diff-line-prefix">${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}</span>
                      <span class="diff-line-text" dangerouslySetInnerHTML=${{ __html: highlight(line.text, lang) }}></span>
                    </div>
                  `)}
                </div>
              `}
            ${!expanded && hidden > 0 && html`
              <button type="button" class="expand-btn" onClick=${() => setExpanded(true)}>
                <span class="collapse-btn-icon">▾</span> Show ${hidden} more lines
              </button>
            `}
            ${expanded && hidden > 0 && collapseFooter}
          </div>
        </div>
      </div>
    `;
  }

  // AskUserQuestion — review-mode card. Three zoom levels:
  //   L1: collapsed row (badge, N-questions chip, first question, duration)
  //   L2: expanded card showing each question + its selected answer line(s)
  //   L3: per-question expansion revealing the full options grid for that Q
  // Renders only what the transcript records — no derived status pills, no
  // editorial copy. Rejection / true-error metadata surfaces as a small tag.
  if (event.event_type === "tool_call_start" && event.tool_name === "AskUserQuestion") {
    const askInput = tryParseJson(event.input_data) ?? {};
    const rawQuestions = Array.isArray(askInput.questions) ? askInput.questions : [];
    const questions: AskQuestion[] = rawQuestions.filter(
      (q): q is AskQuestion => !!q && typeof q === "object" && typeof (q as AskQuestion).question === "string",
    );
    const askOutput = parseAskOutput(event.output_data, questions);
    const answers = askOutput?.answers ?? {};
    const annotations = askOutput?.annotations ?? {};
    const headerText = questions[0]?.question ?? "AskUserQuestion";

    // Factual metadata — surfaced as small tags, not error styling.
    const askMeta = parseMetadata(event);
    const wasRejected = askMeta?.permission_status === "rejected";
    const wasToolError = askMeta?.tool_error === true;

    // Per-question selected/custom split. No status classification.
    const perQ = questions.map((q) => {
      const optList = Array.isArray(q.options) ? q.options : [];
      const optionLabels = new Set(optList.map(o => o.label));
      const rawAnswer = (answers as Record<string, AskAnswerValue>)[q.question];
      const values = normalizeAnswerValues(rawAnswer).filter(v => v.length > 0);
      const selectedFromOptions = values.filter(v => optionLabels.has(v));
      const customValues = values.filter(v => !optionLabels.has(v));
      const note = annotations[q.question]?.notes;
      return { q, optList, selectedFromOptions, customValues, note };
    });

    return html`
      <div class="tool-row-standalone ask-card"
        onClick=${toggleExpand}
      >
        <div class="event-dot dot-tool"></div>
        <div class="tool-row-content">
          <div class="tool-row">
            ${groupIndex != null && html`<span class="tg-item-badge">#${groupIndex}</span>`}
            <span class=${"tool-badge " + toolBadgeClass}>AskUserQuestion</span>
            ${questions.length > 1 && html`<span class="ask-questions-count">${questions.length} questions</span>`}
            <span class="tool-name">${truncate(headerText, 80)}</span>
            ${wasToolError && html`<span class="ask-meta-tag is-error">error</span>`}
            ${!wasToolError && wasRejected && html`<span class="ask-meta-tag is-rejected">rejected</span>`}
            <span class="tool-dur">${formatDuration(event.duration_ms)}</span>
            <span class="tool-row-expand">${expanded ? "▾" : "›"}</span>
          </div>
          ${expanded && html`
            <div class="event-detail ask-detail" onClick=${stopToggle}>
              ${questions.length === 0 && html`
                <div class="ask-empty">(no questions in input)</div>
              `}
              ${questions.length > 0 && html`
                <div class="ask-card-expanded">
                  ${perQ.map(({ q, optList, selectedFromOptions, customValues, note }, idx) => {
                    const copyText = formatAskQuestionForCopy(q, selectedFromOptions, customValues, note);
                    const showCounter = questions.length > 1;
                    const qExpanded = expandedQs.has(idx);
                    const hasOptions = optList.length > 0;
                    return html`
                      <div class="ask-q-block">
                        <div class="ask-q-header"
                          onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleQ(idx); }}
                        >
                          ${showCounter && html`<span class="ask-q-counter">Q${idx + 1}</span>`}
                          <span class="ask-q-prompt">${q.question}</span>
                          ${q.multiSelect === true && html`<span class="ask-q-multi">multi-select</span>`}
                          <${CopyButton} text=${copyText} />
                          ${hasOptions && html`<span class="ask-q-expand" aria-label=${qExpanded ? "Collapse options" : "Show options"}>${qExpanded ? "▾" : "▸"}</span>`}
                        </div>

                        ${(selectedFromOptions.length > 0 || customValues.length > 0) && html`
                          <div class="ask-q-answers">
                            ${selectedFromOptions.map((v) => html`
                              <div class="ask-q-answer-line">
                                <span class="arrow">→</span>${v}
                              </div>
                            `)}
                            ${customValues.map((v) => html`
                              <div class="ask-q-answer-line is-custom">
                                <span class="arrow">→</span>${v}<span class="ask-custom-tag">custom</span>
                              </div>
                            `)}
                          </div>
                        `}

                        ${qExpanded && hasOptions && html`
                          <div class="ask-options-grid">
                            ${optList.map((opt) => {
                              const isSelected = selectedFromOptions.includes(opt.label);
                              return html`
                                <div class=${"ask-option " + (isSelected ? "is-selected" : "is-muted")}>
                                  <div class="ask-option-key">${opt.label}</div>
                                  ${opt.description
                                    ? html`<div class="ask-option-rationale">${opt.description}</div>`
                                    : html`<div class="ask-option-rationale"></div>`
                                  }
                                  ${isSelected && html`
                                    <svg class="ask-option-check" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                      <circle cx="12" cy="12" r="10"/>
                                      <path d="m8 12 3 3 5-6" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
                                    </svg>
                                  `}
                                </div>
                              `;
                            })}
                          </div>
                        `}

                        ${note && html`<div class="ask-note">Note: ${note}</div>`}
                      </div>
                    `;
                  })}
                </div>
              `}
              ${(wasToolError || wasRejected || (questions.length > 0 && !askOutput))
                && (event.output_data || event.output_preview) && html`
                <div class="detail-section">
                  ${sectionHeader("Output", event.output_data || event.output_preview)}
                  ${StructuredContent({ text: event.output_data || event.output_preview })}
                </div>
              `}
              ${collapseFooter}
            </div>
          `}
        </div>
      </div>
    `;
  }

  // Gap 2: Lightweight tool rows for standalone tool_call_start events
  // Gaps 11 & 12: No timestamp, no type pill on tool rows
  if (event.event_type === "tool_call_start") {
    const isErr = isToolErrorEvent(event);

    return html`
      <div class=${"tool-row-standalone" + (isErr ? " tool-row-standalone-error" : "")}
        onClick=${hasExpandable ? toggleExpand : undefined}
      >
        <div class=${"event-dot dot-tool" + (isErr ? " dot-tool-err" : "")}></div>
        <div class="tool-row-content">
          <div class=${"tool-row" + (isErr ? " tool-row-error" : "")}>
            ${groupIndex != null && html`<span class="tg-item-badge">#${groupIndex}</span>`}
            <span class=${"tool-badge " + toolBadgeClass}>${event.tool_name}</span>
            ${isErr && html`<span class="err-badge">error</span>`}
            ${(() => {
              const tuInfo = getTaskUpdateInfo(event);
              if (tuInfo) {
                const statusClass = tuInfo.status === "completed" ? "status-completed"
                  : tuInfo.status === "in_progress" ? "status-in-progress"
                  : tuInfo.status === "blocked" ? "status-blocked" : "";
                return html`<span class="tool-name">#${tuInfo.taskId} → <span class=${"status-val " + statusClass}>${tuInfo.status}</span></span>`;
              }
              return html`<span class="tool-name">${toolSummary || event.tool_name}</span>`;
            })()}
            <span class="tool-dur">${formatDuration(event.duration_ms)}</span>
            <span class="tool-row-expand">${expanded ? "▾" : "›"}</span>
          </div>
          ${expanded && html`
            <div class="event-detail" onClick=${stopToggle}>
              ${event.tool_name === "Edit" && (() => {
                const input = tryParseJson(event.input_data);
                if (!input?.old_string) return null;
                const diffLines = computeLineDiff(String(input.old_string), String(input.new_string || ""));
                return html`
                  <div class="detail-section">
                    ${sectionHeader(`Edit: ${input.file_path || ""}`, String(input.new_string ?? ""))}
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
              ${event.tool_name !== "Edit" && event.input_data && html`
                <div class="detail-section">
                  ${sectionHeader("Input", event.input_data)}
                  ${StructuredContent({ text: event.input_data, hint: "json" })}
                </div>
              `}
              ${(event.output_preview || event.output_data) && !(event.tool_name === "Edit" && /has been (updated|created) successfully/.test(event.output_preview || "")) && html`
                <div class="detail-section">
                  ${sectionHeader("Output", event.output_data || event.output_preview)}
                  ${StructuredContent({ text: event.output_data || event.output_preview })}
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
              ${collapseFooter}
            </div>
          `}
        </div>
      </div>
    `;
  }

  // Determine extra CSS classes for special message types
  const extraClass = isSkillExpansion ? " event-skill-expansion" : isSystemGenerated ? " event-system-tagged" : "";
  const permissionClass = isRejected ? " event-tool-rejected" : isToolError ? " event-tool-error" : "";

  // TaskOutput — add task-event class and dot override
  const isTaskOutput = event.tool_name === "TaskOutput";
  const taskClass = isTaskOutput ? " task-event" : "";

  return html`
    <div
      class=${typeClass + (hasExpandable ? " expandable" : "") + extraClass + taskClass + permissionClass}
      onClick=${hasExpandable ? toggleExpand : undefined}
    >
      <div class=${isTaskOutput ? "event-dot event-dot-task" : "event-dot"} style=${getDotStyle(event.event_type, !!isSystemGenerated, !!isSkillExpansion)}></div>
      <div class="event-content">
      <div class="event-header">
        <span class="event-time">${formatTime(event.timestamp, sessionStart)}</span>
        ${isSystemGenerated && html`<span class="event-pill pill-gray">system</span>`}
        ${!isToolEvent && !isCommand && !isSkillExpansion && !isSystemGenerated && !SUPPRESS_PILL_TYPES.has(event.event_type) && html`<span class=${"event-pill " + pillClass + (isRoleMsg ? " pill-role" : "")}>${isRoleMsg ? label.toUpperCase() : label}</span>`}
        ${event.tool_name && html`<span class=${"tool-badge " + toolBadgeClass}>${event.tool_name}</span>`}
        ${isRejected && html`<span class="permission-badge rejected">rejected</span>`}
        ${isToolError && !isRejected && html`<span class="permission-badge error">error</span>`}
        ${isTaskOutput && html`<span class="tool-summary">Sub-agent result</span>`}
        ${toolSummary && html`<span class="tool-summary">${toolSummary}</span>`}
        ${event.event_type === "subagent_start" && event.input_preview && html`<span class="agent-desc">${truncate(event.input_preview, 60)}</span>`}
        ${event.event_type === "thinking" && event.input_tokens != null && html`<span class="event-duration">${event.input_tokens} tokens</span>`}
        ${!toolSummary && (() => { const fp = extractFilePath(event); return fp ? html`<code class="event-file-path" title=${fp}>${shortenPath(fp)}</code>` : null; })()}
        ${event.context_pct != null && event.context_pct >= 50 && html`
          <span class="event-ctx">
            <span class="ctx-minibar">
              <span class="ctx-minibar-fill" style="width: ${Math.min(event.context_pct, 100)}%; background: ${event.context_pct >= 70 ? 'var(--color-status-danger-text)' : 'var(--color-status-warning-text)'}"></span>
            </span>
            <span class="mono">${Math.round(event.context_pct)}%</span>
          </span>
        `}
        ${event.duration_ms != null && html`<span class=${"event-duration" + (isTaskOutput && event.duration_ms > 10000 ? " duration-highlight" : "")}>${formatDuration(event.duration_ms)}</span>`}
        ${hasExpandable && html`<span class="event-expand">${expanded ? "▾" : "▸"}</span>`}
      </div>

      ${!expanded && event.event_type === "thinking" && event.thinking_summary && html`
        <div class="event-body event-body-thinking" onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleExpand(); }}>
          ${event.thinking_summary}
          <div class="fade"></div>
        </div>
      `}

      ${!expanded && event.event_type === "assistant_message" && event.output_preview && (() => {
        // Fade the bottom only when the preview is long enough to actually
        // be clipped by the 72px max-height (~3-4 lines); short replies
        // shouldn't get a gradient over their last line.
        const op = event.output_preview;
        const truncated = op.length > 160 || op.split("\n").length > 3;
        return html`
          <div class=${"event-body event-body-assistant markdown-content" + (truncated ? " has-fade" : "")}
            dangerouslySetInnerHTML=${{ __html: renderMarkdown(op) }}
            onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleExpand(); }}
          />
        `;
      })()}

      ${!expanded && event.event_type === "user_message" && !isSkillExpansion && !isSystemGenerated && (isCommand || event.input_preview) && html`
        <div class="event-body event-body-user" onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleExpand(); }}>
          ${isCommand
            ? (() => {
                const cmdArgs = getCommandArgs(meta!);
                return html`<span class="command-pill">${meta!.command}</span>${cmdArgs ? ` ${cmdArgs}` : null}`;
              })()
            : event.input_preview}
        </div>
      `}

      ${!expanded && event.event_type === "user_message" && isSkillExpansion && html`
        <div class="event-body skill-expansion-body" onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleExpand(); }}>
          <span class="skill-badge">skill: ${skillName || "expansion"}</span>
          <span class="skill-expansion-label">${event.input_preview ? truncate(event.input_preview, 120) : "[skill expansion content]"}</span>
        </div>
      `}

      ${!expanded && event.event_type === "user_message" && isSystemGenerated && html`
        <div class="event-body event-body-system" onClick=${(e: globalThis.Event) => { e.stopPropagation(); toggleExpand(); }}>
          <span class="system-tag-preview">${event.input_preview}</span>
        </div>
      `}

      ${event.event_type === "compaction" && !expanded && html`
        <div class="compaction-banner">
          <span class="compaction-banner-icon">&#9888;</span>
          <div class="compaction-banner-info">
            <div class="compaction-banner-title">Auto-compaction triggered</div>
            <div class="compaction-banner-desc">
              ${compactionDescription(event)}
            </div>
          </div>
        </div>
      `}

      ${expanded && html`
        <div class="event-detail" onClick=${stopToggle}>
          ${event.thinking_text && html`
            <div class="detail-section">
              ${sectionHeader("Thinking", event.thinking_text)}
              ${StructuredContent({ text: event.thinking_text, hint: "markdown" })}
            </div>
          `}
          ${event.input_preview && html`
            <div class="detail-section">
              ${sectionHeader("Input", event.input_data || event.input_preview)}
              ${StructuredContent({ text: event.input_data || event.input_preview })}
            </div>
          `}
          ${event.output_preview && event.event_type === "assistant_message" && html`
            <div class="detail-section">
              ${sectionHeader("Output", event.output_data || event.output_preview)}
              <div class="detail-content markdown-content"
                dangerouslySetInnerHTML=${{ __html: renderMarkdown(event.output_data || event.output_preview) }}
              />
            </div>
          `}
          ${event.output_preview && event.event_type !== "assistant_message" && html`
            <div class="detail-section">
              ${sectionHeader("Output", event.output_data || event.output_preview)}
              ${StructuredContent({ text: event.output_data || event.output_preview })}
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
          ${collapseFooter}
        </div>
      `}
      </div>
    </div>
  `;
}
