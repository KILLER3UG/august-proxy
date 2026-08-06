-- 009_recurring_tasks.sql
-- Recurring-task daemon (B7): user-defined reminders like
-- "every time I open this repo, remind me to run the migration" or
-- "every 2 hours, remind me to stand up".
CREATE TABLE IF NOT EXISTS recurring_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger TEXT NOT NULL,
    message TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_recurring_tasks_active ON recurring_tasks(active);
