export const INITIAL_SCHEMA = `
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    project_name TEXT,
    model TEXT,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cache_read_tokens INTEGER DEFAULT 0,
    total_cache_write_tokens INTEGER DEFAULT 0,
    peak_context_pct REAL,
    compaction_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    subagent_count INTEGER DEFAULT 0,
    risk_score REAL,
    summary TEXT,
    end_reason TEXT,
    transcript_path TEXT,
    metadata TEXT
);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_event_id INTEGER REFERENCES events(id),
    agent_id TEXT,
    event_type TEXT NOT NULL,
    event_source TEXT NOT NULL DEFAULT 'transcript_import',
    tool_name TEXT,
    timestamp TEXT NOT NULL,
    sequence_num INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    context_pct REAL,
    input_preview TEXT,
    input_data TEXT,
    output_preview TEXT,
    output_data TEXT,
    thinking_summary TEXT,
    thinking_text TEXT,
    duration_ms INTEGER,
    metadata TEXT
);

CREATE TABLE agent_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    child_agent_id TEXT NOT NULL,
    child_transcript_path TEXT,
    prompt_preview TEXT,
    result_preview TEXT,
    prompt_data TEXT,
    result_data TEXT,
    started_at TEXT,
    ended_at TEXT,
    duration_ms INTEGER,
    input_tokens_total INTEGER,
    output_tokens_total INTEGER,
    tool_call_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running'
);

CREATE INDEX idx_sessions_project ON sessions(project_path);
CREATE INDEX idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_events_session ON events(session_id, sequence_num);
CREATE INDEX idx_events_session_time ON events(session_id, timestamp);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_tool ON events(tool_name);
CREATE INDEX idx_events_agent ON events(agent_id);
CREATE INDEX idx_agent_rel_parent ON agent_relationships(parent_session_id);
`;
