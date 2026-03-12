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
}

// ── Summary generation ──────────────────────────────────────────────

/**
 * Generate a concise one-line session summary (~150 chars max).
 */
export function generateSessionSummary(input: SummaryInput): string {
  const parts: string[] = [];

  // Model name (extract family from full model string)
  const modelName = extractModelName(input.model);
  parts.push(`${modelName} session`);

  // Duration
  if (input.durationMs && input.durationMs > 0) {
    parts.push(formatDuration(input.durationMs));
  }

  // Tool calls with top tools
  if (input.toolCallCount > 0) {
    const toolPart = input.topTools.length > 0
      ? `${input.toolCallCount} tool calls (${input.topTools.join(', ')})`
      : `${input.toolCallCount} tool calls`;
    parts.push(toolPart);
  }

  // Compactions (only if > 0)
  if (input.compactionCount > 0) {
    parts.push(`${input.compactionCount} compaction${input.compactionCount !== 1 ? 's' : ''}`);
  }

  // Subagents (only if > 0)
  if (input.subagentCount > 0) {
    parts.push(`${input.subagentCount} subagent${input.subagentCount !== 1 ? 's' : ''}`);
  }

  // Peak context
  if (input.peakContextPct != null && input.peakContextPct > 0) {
    parts.push(`peak ${input.peakContextPct.toFixed(0)}% context`);
  }

  // Risk level
  parts.push(`${capitalize(input.riskLevel)} risk`);

  // Join with ". " for first part, then ", " style
  const summary = parts[0] + (parts.length > 1 ? ', ' + parts.slice(1).join('. ') : '') + '.';

  // Truncate to ~150 chars
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

  // Return last segment or cleaned up name
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
