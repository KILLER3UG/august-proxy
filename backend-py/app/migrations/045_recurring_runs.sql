-- 045_recurring_runs.sql — per-fire history for recurring tasks (B7 polish:
-- parity with the automations store's runs ledger, capped at 20 per task by
-- app/services/recurring_tasks.py on every write).
CREATE TABLE IF NOT EXISTS recurring_task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    fired_at TEXT NOT NULL,
    message TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recurring_runs_task ON recurring_task_runs(task_id, id DESC);
