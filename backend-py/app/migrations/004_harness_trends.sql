-- 004_harness_trends.sql
-- Weekly aggregation of harness metrics for longitudinal tracking.
-- Part of Better Harness Plan Phase 5.4.

CREATE TABLE IF NOT EXISTS harness_trends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL UNIQUE,
    friction_total INTEGER DEFAULT 0,
    friction_by_category TEXT DEFAULT '{}',
    evidence_verified_pct REAL DEFAULT 0,
    memory_retrievals INTEGER DEFAULT 0,
    skill_invocations INTEGER DEFAULT 0,
    sessions_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
