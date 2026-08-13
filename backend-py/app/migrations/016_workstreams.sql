-- Named workstreams (Nac-style threads) with ordered episodes.
-- Episodes are the durable handoff; worker tool traces are discarded.

CREATE TABLE IF NOT EXISTS workstreams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workstreams_session ON workstreams(session_id);

CREATE TABLE IF NOT EXISTS workstream_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workstream_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    task_id TEXT DEFAULT '',
    status TEXT DEFAULT 'completed',
    summary TEXT DEFAULT '',
    artifacts TEXT DEFAULT '[]',
    next_action TEXT DEFAULT '',
    raw_json TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workstream_id, seq),
    FOREIGN KEY (workstream_id) REFERENCES workstreams(id)
);

CREATE INDEX IF NOT EXISTS idx_workstream_episodes_ws ON workstream_episodes(workstream_id);
