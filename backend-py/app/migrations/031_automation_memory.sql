-- Part 21 M-11 (2026-09-01): automation persistent memory. Three tables in
-- the brain DB next to turn_outcomes (high-frequency append is wrong for
-- automations.json's whole-file rewrite cycle):
--   automation_runs      — one row per run attempt, immutable terminal states
--   automation_notes     — per-job KV notepad (caps enforced in service code)
--   automation_incidents — deduped failures (one open row per signature)
-- Wake-up context for routines is assembled in automation_memory.py.
CREATE TABLE IF NOT EXISTS automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',   -- running|succeeded|failed|timeout|cancelled
    trigger TEXT NOT NULL DEFAULT 'cron',     -- cron|manual|chain
    duration_ms INTEGER,
    result_excerpt TEXT DEFAULT '',           -- head 4 KiB of output; full text stays in the session transcript
    error_signature TEXT DEFAULT '',
    agent_id TEXT DEFAULT '',
    session_id TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_auto_runs_job ON automation_runs(job_id, started_at);

CREATE TABLE IF NOT EXISTS automation_notes (
    job_id TEXT NOT NULL,
    note_key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT,
    PRIMARY KEY (job_id, note_key)
);

CREATE TABLE IF NOT EXISTS automation_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    error_signature TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT,
    state TEXT NOT NULL DEFAULT 'detected',  -- detected|alerted|closed
    occurrences INTEGER DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_incident_open
    ON automation_incidents(job_id, error_signature) WHERE state != 'closed';
