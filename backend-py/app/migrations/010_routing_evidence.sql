-- 010_routing_evidence.sql
-- Evidence loop (surpass #1/#7): per-turn model outcomes by task type, fed
-- by normal turns and arena/debate winner picks. Drives routing suggestions.
CREATE TABLE IF NOT EXISTS routing_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    task_type TEXT DEFAULT 'general',
    model TEXT,
    provider TEXT,
    ok INTEGER DEFAULT 1,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    source TEXT DEFAULT 'turn',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_evidence_task ON routing_evidence(task_type);
CREATE INDEX IF NOT EXISTS idx_routing_evidence_model ON routing_evidence(model);
