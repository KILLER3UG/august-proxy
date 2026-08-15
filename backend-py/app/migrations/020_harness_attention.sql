-- Attention (last-seen) + routine schedule / pause.

CREATE TABLE IF NOT EXISTS workstream_reads (
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    last_seen_seq INTEGER DEFAULT 0,
    seen_at TEXT,
    PRIMARY KEY (session_id, name)
);

ALTER TABLE harness_routines ADD COLUMN schedule TEXT DEFAULT '';
ALTER TABLE harness_routines ADD COLUMN paused INTEGER DEFAULT 0;
ALTER TABLE harness_routines ADD COLUMN last_run TEXT DEFAULT '';
