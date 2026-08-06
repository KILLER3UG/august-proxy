-- 006_subagent_runs.sql
-- Persistent sub-agent run history (visibility-first orchestration UI).
-- Previously run state lived only in orchestrator process memory; this
-- table makes past runs browsable per session and per agent.

CREATE TABLE IF NOT EXISTS subagent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT UNIQUE NOT NULL,
    session_id TEXT DEFAULT '',
    agent_id TEXT DEFAULT 'general',
    goal TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    result_summary TEXT DEFAULT '',
    error TEXT DEFAULT '',
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subagent_runs_session ON subagent_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_created ON subagent_runs(created_at);

-- Provenance + feedback for learned heuristics (Phase A4):
--  * source_session_id — which conversation produced the rule
--  * suppressed       — user/agent marked the rule wrong; excluded from prompts
ALTER TABLE learned_heuristics ADD COLUMN source_session_id TEXT;
ALTER TABLE learned_heuristics ADD COLUMN suppressed INTEGER DEFAULT 0;
