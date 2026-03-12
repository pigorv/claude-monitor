import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContextThresholds, EventType } from './types.js';

export const VERSION = '0.1.0';

export const MODEL_PRICING: Record<string, { input_per_mtok: number; output_per_mtok: number }> = {
  opus:   { input_per_mtok: 15, output_per_mtok: 75 },
  sonnet: { input_per_mtok: 3, output_per_mtok: 15 },
  haiku:  { input_per_mtok: 0.25, output_per_mtok: 1.25 },
};

export const MODEL_THRESHOLDS: Record<string, ContextThresholds> = {
  opus:   { model: 'opus',   maxTokens: 200_000, autoCompactPct: 75.0,  warningPct: 60.0, dangerPct: 70.0 },
  sonnet: { model: 'sonnet', maxTokens: 200_000, autoCompactPct: 83.5,  warningPct: 65.0, dangerPct: 75.0 },
  haiku:  { model: 'haiku',  maxTokens: 200_000, autoCompactPct: 90.0,  warningPct: 70.0, dangerPct: 80.0 },
};

const dataDir = join(homedir(), '.claude-monitor');

export const DEFAULT_CONFIG = Object.freeze({
  dataDir,
  dbPath: join(dataDir, 'data.sqlite'),
  eventsFilePath: join(dataDir, 'events.jsonl'),
  defaultPort: 4173,
  claudeProjectsPath: join(homedir(), '.claude', 'projects'),
});

export const EVENT_TYPES: readonly EventType[] = [
  'session_start',
  'session_end',
  'tool_call_start',
  'tool_call_end',
  'subagent_start',
  'subagent_end',
  'compaction',
  'thinking',
  'assistant_message',
  'user_message',
  'notification',
] as const;

export const PREVIEW_LIMITS = Object.freeze({
  inputPreview: 500,
  outputPreview: 500,
  thinkingSummary: 200,
});
