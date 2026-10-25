-- 058: goal_envs.workspace — a project keeps its own goals and its own bound.
--
-- Octopus: "A goal with its own context and permissions. What an agent may do in one project
-- says nothing about another." The column is additive and defaults to '' (the global root), so
-- every row written before this file keeps working; a fresh database gets it from
-- create_extended_tables. Idempotent by construction: the ALTER is tolerated as already-applied
-- on a database born with the column.

ALTER TABLE goal_envs ADD COLUMN workspace TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_goal_envs_workspace ON goal_envs(workspace, status);
