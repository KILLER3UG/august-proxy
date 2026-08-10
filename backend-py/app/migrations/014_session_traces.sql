-- 014_session_traces.sql
-- Per-turn execution traces: prompt hash, tools offered/called, rounds,
-- self-heal events, graded outcome. Enables replay, regression diffs and
-- drift alerts that routing_evidence aggregates cannot answer.
CREATE TABLE IF NOT EXISTS session_traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    turn_seq INTEGER DEFAULT 0,
    prompt_hash TEXT,
    prompt_preview TEXT,
    task_type TEXT DEFAULT 'general',
    model TEXT,
    provider TEXT,
    outcome TEXT,
    rounds INTEGER DEFAULT 0,
    tools_offered INTEGER DEFAULT 0,
    tool_calls TEXT,
    self_heal_events TEXT,
    evidence_state TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_traces_session ON session_traces(session_id, turn_seq);
CREATE INDEX IF NOT EXISTS idx_session_traces_model ON session_traces(model);
CREATE INDEX IF NOT EXISTS idx_session_traces_created ON session_traces(created_at);
