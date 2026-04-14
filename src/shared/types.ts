// ── String union types ──────────────────────────────────────────────

export type SessionStatus = 'running' | 'completed' | 'imported';

export type SessionSource = 'startup' | 'resume' | 'clear' | 'compact';

export type EventType =
  | 'session_start'
  | 'session_end'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'subagent_start'
  | 'subagent_end'
  | 'compaction'
  | 'thinking'
  | 'assistant_message'
  | 'user_message'
  | 'notification';

export type EventSource = 'transcript_import';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

// ── Database / domain interfaces ────────────────────────────────────

export interface Session {
  id: string;
  project_path: string;
  project_name: string | null;
  model: string | null;
  models_used: string | null;
  source: string | null;
  status: SessionStatus;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  peak_context_pct: number | null;
  compaction_count: number;
  tool_call_count: number;
  subagent_count: number;
  risk_score: number | null;
  summary: string | null;
  end_reason: string | null;
  transcript_path: string | null;
  metadata: string | null;
  agent_avg_compression: number | null;
  agent_total_tokens: number;
  agent_pressure_events: number;
  agent_compacted_count: number;
  peak_concurrency: number;
}

export interface Event {
  id: number;
  session_id: string;
  parent_event_id: number | null;
  agent_id: string | null;
  event_type: EventType;
  event_source: EventSource;
  tool_name: string | null;
  timestamp: string;
  sequence_num: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  context_pct: number | null;
  input_preview: string | null;
  input_data: string | null;
  output_preview: string | null;
  output_data: string | null;
  thinking_summary: string | null;
  thinking_text: string | null;
  duration_ms: number | null;
  metadata: string | null;
}

export interface AgentRelationship {
  id: number;
  parent_session_id: string;
  child_agent_id: string;
  child_transcript_path: string | null;
  prompt_preview: string | null;
  result_preview: string | null;
  prompt_data: string | null;
  result_data: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  input_tokens_total: number | null;
  output_tokens_total: number | null;
  tool_call_count: number;
  status: string;
  internal_tool_calls?: InternalToolCall[];
  prompt_tokens: number | null;
  result_tokens: number | null;
  peak_context_tokens: number | null;
  compression_ratio: number | null;
  agent_compaction_count: number;
  parent_headroom_at_return: number | null;
  parent_impact_pct: number | null;
  result_classification: string | null;
  execution_mode: string | null;
  files_read_count: number;
  files_total_tokens: number;
  spawn_timestamp: string | null;
  complete_timestamp: string | null;
}

// ── JSONL transcript types ──────────────────────────────────────────

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock | ToolResultBlock;

export interface TranscriptMessage {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'system';
  timestamp: string;
  content: ContentBlock[];
  usage?: UsageInfo;
  sessionId?: string;
  cwd?: string;
  model?: string;
  messageId?: string;
}

// ── Analysis types ──────────────────────────────────────────────────

export interface ContextThresholds {
  model: string;
  maxTokens: number;
  autoCompactPct: number;
  warningPct: number;
  dangerPct: number;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  signals: RiskSignal[];
}

export interface RiskSignal {
  name: string;
  value: number;
  weight: number;
  description: string;
  event_id?: number;
}

export interface TokenDataPoint {
  timestamp: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  context_pct: number;
  event_type: string;
  is_compaction: boolean;
}

// ── Project types ──────────────────────────────────────────────────

export interface ProjectInfo {
  project_path: string;
  project_name: string;
  session_count: number;
}

// ── API response types ──────────────────────────────────────────────

export interface MiniTimelinePoint {
  context_pct: number;
  is_compaction: boolean;
}

export interface SessionSummary {
  id: string;
  project_name: string;
  project_path?: string;
  model: string;
  models_used?: string[];
  status: string;
  started_at: string;
  duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  peak_context_pct: number;
  compaction_count: number;
  tool_call_count: number;
  subagent_count: number;
  risk_score: number;
  risk_level: string;
  summary: string;
  cost_estimate_usd?: number;
  mini_timeline?: MiniTimelinePoint[];
}

export interface SessionListResponse {
  sessions: SessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface CompactionDetail {
  event_id: number;
  timestamp: string;
  tokens_before: number;
  tokens_after: number;
  trigger: 'auto' | 'manual';
  likely_dropped: string[];
}

export interface InternalToolCall {
  tool_name: string;
  file_path?: string;
  duration_ms?: number;
  result_char_count?: number;
  estimated_tokens?: number;
  input_preview?: string;
  result_preview?: string;
}

export interface AgentEfficiencyAggregates {
  total_agents: number;
  aggregate_tokens: number;
  avg_compression_ratio: number | null;
  agents_with_compaction: number;
  parent_pressure_events: number;
  avg_agent_duration_ms: number | null;
  peak_concurrency: number;
}

export interface LinkedSession {
  session_id: string;
  project_name: string | null;
  model: string | null;
  started_at: string;
  duration_ms: number | null;
  summary: string | null;
  relationship: 'planning_session' | 'implementation_session';
}

export interface FileActivityEntry {
  file_path: string;
  read_count: number;
  total_tokens: number;
  first_read: string;
  has_partial: boolean;
  is_reread_after_compaction: boolean;
  is_skill_file: boolean;
}

export interface FileActivityData {
  files: FileActivityEntry[];
  total_reread_tokens: number;
  reread_after_compaction_count: number;
  files_with_subagents: FileActivityEntry[];
  total_reread_tokens_with_subagents: number;
  reread_after_compaction_count_with_subagents: number;
}

export interface EventAnnotation {
  index: number;
  marker_type: 'file_read' | 'file_write' | 'agent' | 'bash' | 'other_tool';
  tool_name: string;
  label: string;
  token_delta?: number;
}

export interface SessionDetailResponse {
  session: Session;
  token_timeline: TokenDataPoint[];
  agents: (AgentRelationship & { internal_tool_calls?: InternalToolCall[]; token_timeline?: TokenDataPoint[] })[];
  risk: RiskAssessment;
  stats: SessionStats;
  compaction_details?: CompactionDetail[];
  event_count?: number;
  agent_efficiency?: AgentEfficiencyAggregates;
  linked_sessions?: LinkedSession[];
  file_activity?: FileActivityData;
  peak_parent_tokens?: number;
  event_annotations?: EventAnnotation[];
}

export interface SessionStats {
  unique_tools: string[];
  tool_frequency: Record<string, number>;
  avg_tool_duration_ms: number;
  files_read: string[];
  files_written: string[];
}

export interface HealthResponse {
  status: 'ok';
  version: string;
  node_version?: string;
  db_path?: string;
  db_engine?: string;
  server_port?: number;
  db_size_bytes: number;
  session_count: number;
  event_count: number;
  oldest_session?: string | null;
  newest_session?: string | null;
}
