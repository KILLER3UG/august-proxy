-- 002_memory_lifecycle.sql
-- Track memory lifecycle events: created, retrieved, applied, effective, stale.
-- Part of Better Harness Plan Phase 3.1.

CREATE TABLE IF NOT EXISTS memory_lifecycle (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_key TEXT NOT NULL,
    event TEXT NOT NULL CHECK(event IN ('created', 'retrieved', 'applied', 'effective', 'stale')),
    session_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_key ON memory_lifecycle(memory_key);
CREATE INDEX IF NOT EXISTS idx_lifecycle_event ON memory_lifecycle(event);
CREATE INDEX IF NOT EXISTS idx_lifecycle_created ON memory_lifecycle(created_at);
