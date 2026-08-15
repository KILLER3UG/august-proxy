-- Reusable specialists and episode routines for the workstream harness.

CREATE TABLE IF NOT EXISTS harness_specialists (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    workstream TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT 'general',
    skills_json TEXT DEFAULT '[]',
    model TEXT DEFAULT '',
    acceptance TEXT DEFAULT '',
    restricted_tools_json TEXT DEFAULT '[]',
    autonomy TEXT NOT NULL DEFAULT 'ask',
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_harness_specialists_session
    ON harness_specialists(session_id);

CREATE TABLE IF NOT EXISTS harness_routines (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    workstream TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    skills_json TEXT DEFAULT '[]',
    agent_id TEXT NOT NULL DEFAULT 'general',
    specialist_id TEXT DEFAULT '',
    source_seq INTEGER DEFAULT 0,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_harness_routines_session
    ON harness_routines(session_id);
