-- 008_brain_events.sql
-- Durable brain event history (B4): the in-memory ring buffer (200 cap)
-- loses the Activity feed on restart; this table keeps the full tail.
CREATE TABLE IF NOT EXISTS brain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    category TEXT,
    layer TEXT,
    summary TEXT,
    meta TEXT DEFAULT '{}',
    at TEXT
);

CREATE INDEX IF NOT EXISTS idx_brain_events_at ON brain_events(at);
CREATE INDEX IF NOT EXISTS idx_brain_events_category ON brain_events(category);
