-- 005_consolidation_audit.sql
-- Audit trail for consolidation daemon actions (merge/promote/delete).
-- Part of Better Harness Plan Phase 5.5.

CREATE TABLE IF NOT EXISTS consolidation_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL CHECK(action IN ('merge', 'promote', 'delete', 'stale')),
    target_key TEXT,
    reason TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_action ON consolidation_audit(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON consolidation_audit(created_at);
