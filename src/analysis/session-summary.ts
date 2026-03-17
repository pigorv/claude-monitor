import type { RiskLevel } from '../shared/types.js';

// ── Input type ──────────────────────────────────────────────────────

export interface SummaryInput {
  model: string | null;
  durationMs: number | null;
  toolCallCount: number;
  topTools: string[];
  compactionCount: number;
  subagentCount: number;
  peakContextPct: number | null;
  riskLevel: RiskLevel;
  firstUserMessage?: string;
}

// ── Summary generation ──────────────────────────────────────────────

/**
 * Generate a session summary from the first user message.
 * Falls back to a stats-based summary if no user message is available.
 */
export function generateSessionSummary(input: SummaryInput): string {
  // Use first user message as summary title if available
  if (input.firstUserMessage) {
    return extractTitle(input.firstUserMessage);
  }

  // Fallback: stats-based summary
  return generateStatsSummary(input);
}

/**
 * Extract a clean, concise title from the first user message.
 * Handles command tags, skill invocations, and truncates to ~120 chars.
 */
function extractTitle(message: string): string {
  let text = message.trim();

  // If message has <command-args>, use that as the primary source
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (argsMatch) {
    text = argsMatch[1].trim();
  } else {
    // Strip all XML-like tags (command-message, command-name, system-reminder, etc.)
    text = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
  }

  // Strip slash command prefixes like "/claude-monitor-pm"
  text = text.replace(/^\/[\w-]+\s*/, '');

  // Strip "Base directory for this skill:" preamble
  text = text.replace(/^Base directory for this skill:.*?\n+/s, '');

  // Strip ARGUMENTS: prefix from skill expansions
  text = text.replace(/^ARGUMENTS:\s*/i, '');

  // Strip @file references and collapse multiple spaces
  text = text.replace(/@[\w./-]+/g, '');
  text = text.replace(/\s{2,}/g, ' ').trim();

  // Strip leading whitespace again
  text = text.trim();

  // If still empty after stripping, return generic
  if (!text) return 'Session';

  // Take first line only (or first sentence)
  const firstLine = text.split('\n')[0].trim();

  // Truncate to ~120 chars at word boundary
  if (firstLine.length > 120) {
    const truncated = firstLine.slice(0, 117);
    const lastSpace = truncated.lastIndexOf(' ');
    return (lastSpace > 80 ? truncated.slice(0, lastSpace) : truncated) + '…';
  }

  return firstLine;
}

function generateStatsSummary(input: SummaryInput): string {
  const parts: string[] = [];

  const modelName = extractModelName(input.model);
  parts.push(`${modelName} session`);

  if (input.durationMs && input.durationMs > 0) {
    parts.push(formatDuration(input.durationMs));
  }

  if (input.toolCallCount > 0) {
    const toolPart = input.topTools.length > 0
      ? `${input.toolCallCount} tool calls (${input.topTools.join(', ')})`
      : `${input.toolCallCount} tool calls`;
    parts.push(toolPart);
  }

  if (input.compactionCount > 0) {
    parts.push(`${input.compactionCount} compaction${input.compactionCount !== 1 ? 's' : ''}`);
  }

  if (input.subagentCount > 0) {
    parts.push(`${input.subagentCount} subagent${input.subagentCount !== 1 ? 's' : ''}`);
  }

  if (input.peakContextPct != null && input.peakContextPct > 0) {
    parts.push(`peak ${input.peakContextPct.toFixed(0)}% context`);
  }

  parts.push(`${capitalize(input.riskLevel)} risk`);

  const summary = parts[0] + (parts.length > 1 ? ', ' + parts.slice(1).join('. ') : '') + '.';

  if (summary.length > 150) {
    return summary.slice(0, 147) + '...';
  }

  return summary;
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractModelName(model: string | null): string {
  if (!model) return 'Unknown';

  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';

  const parts = model.split(/[-_]/);
  return parts.length > 0 ? capitalize(parts[parts.length - 1]) : model;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
