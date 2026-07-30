-- 003_friction_events.sql
-- Track friction events with structured attribution categories.
-- Part of Better Harness Plan Phase 3.2.

CREATE TABLE IF NOT EXISTS friction_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN (
        'provider', 'harness', 'model', 'requirement', 'tool', 'external', 'complexity'
    )),
    detail TEXT,
    tool_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_friction_session ON friction_events(session_id);
CREATE INDEX IF NOT EXISTS idx_friction_category ON friction_events(category);
CREATE INDEX IF NOT EXISTS idx_friction_created ON friction_events(created_at);
