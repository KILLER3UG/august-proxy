-- Long-running harness jobs (DAG batches), distinct from chat turns.

CREATE TABLE IF NOT EXISTS harness_jobs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT DEFAULT 'running',
    dirty INTEGER DEFAULT 0,
    error TEXT DEFAULT '',
    waves_json TEXT DEFAULT '[]',
    work_items_json TEXT DEFAULT '[]',
    task_ids TEXT DEFAULT '[]',
    created_at TEXT,
    finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_harness_jobs_session ON harness_jobs(session_id);
