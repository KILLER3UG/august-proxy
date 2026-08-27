-- 026: Knowledge-base redesign (plan 2026-08-27, Part 3).
--
-- M1: machine state is not memory. Maintenance/cron/daemon bookkeeping goes
-- into internal_state; the Memory UI (_BRAINStores) never exposes it.
CREATE TABLE IF NOT EXISTS internal_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- M5: structured per-turn telemetry (append-only; swept after 30 days by the
-- consolidation job). Never injected into prompts, never shown in Memory UI.
CREATE TABLE IF NOT EXISTS turn_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),
    model TEXT DEFAULT '',
    provider TEXT DEFAULT '',
    task_type TEXT DEFAULT '',
    ok INTEGER DEFAULT 1,
    error_class TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0,
    session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_turn_outcomes_ts ON turn_outcomes(ts);
CREATE INDEX IF NOT EXISTS idx_turn_outcomes_model_ok ON turn_outcomes(model, ok);

-- M2 facts column additions (title/kind/use_count/last_used_at/status) are
-- applied via memory_schema.ensure_column (idempotent + concurrent-init-race
-- tolerant); a bare ALTER here would abort the script on a duplicate column
-- and the runner never re-runs failed migrations.
