-- Workspace-scoped specialists/routines (additive).

ALTER TABLE harness_specialists ADD COLUMN workspace_path TEXT DEFAULT '';
ALTER TABLE harness_routines ADD COLUMN workspace_path TEXT DEFAULT '';
