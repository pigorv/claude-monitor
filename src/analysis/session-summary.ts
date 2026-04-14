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
 * Handles slash commands, skill invocations, and truncates to ~120 chars.
 */
function extractTitle(message: string): string {
  const text = message.trim();

  // ── 1. Extract structured command metadata before stripping ──
  const commandNameMatch = text.match(/<command-name>\s*(\/[\w-]+)\s*<\/command-name>/);
  const commandArgsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  const skillPathMatch = text.match(/Base directory for this skill:\s*\S+\/skills\/([^\s/]+)/);

  const commandName = commandNameMatch?.[1]?.trim() || null;
  const commandArgs = commandArgsMatch?.[1]?.trim() || null;
  const skillName = skillPathMatch?.[1] || null;

  // ── 2. Slash commands: use command name as label ──
  if (commandName) {
    if (commandArgs) {
      const argsPreview = truncateAtWordBoundary(commandArgs.split('\n')[0].trim(), 100);
      return `${commandName} — ${argsPreview}`;
    }
    if (skillName && skillName !== commandName.slice(1)) {
      return `${commandName} (${skillName})`;
    }
    return commandName;
  }

  // ── 3. Skill expansion without command-name tag ──
  if (skillName) {
    let cleaned = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
    cleaned = cleaned.replace(/^Base directory for this skill:.*?\n+/s, '').trim();
    cleaned = cleaned.replace(/^ARGUMENTS:\s*/i, '').trim();
    if (cleaned && cleaned.toLowerCase() !== 'none') {
      return truncateAtWordBoundary(cleaned.split('\n')[0].trim(), 120);
    }
    return skillName;
  }

  // ── 4. Regular text messages ──
  let cleaned = text;

  // If message has <command-args>, use that as the primary source
  if (commandArgsMatch) {
    cleaned = commandArgs || '';
  } else {
    // Strip all XML-like tags
    cleaned = cleaned.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
  }

  // Strip slash command prefixes
  cleaned = cleaned.replace(/^\/[\w-]+\s*/, '');

  // Strip skill preamble and ARGUMENTS: prefix
  cleaned = cleaned.replace(/^Base directory for this skill:.*?\n+/s, '');
  cleaned = cleaned.replace(/^ARGUMENTS:\s*/i, '');

  // Strip @file references and collapse whitespace
  cleaned = cleaned.replace(/@[\w./-]+/g, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  if (!cleaned) return 'Session';

  return truncateAtWordBoundary(cleaned.split('\n')[0].trim(), 120);
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

function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen - 1);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.65 ? truncated.slice(0, lastSpace) : truncated) + '…';
}
