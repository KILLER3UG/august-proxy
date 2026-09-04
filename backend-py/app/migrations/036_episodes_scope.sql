-- Part 26 6.4: the learning pipeline honors the M-2 scope axis.
-- Episodes mined from a Bot's private home chat must not resurface as
-- globally injected <memory> lessons in every other session — the same leak
-- class the remember/forget doors closed. NULL/'' = global (every row that
-- predates this column, and every non-Bot session's episodes).
ALTER TABLE episodes ADD COLUMN scope TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_episodes_scope ON episodes(scope);
