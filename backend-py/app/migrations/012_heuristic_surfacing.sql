-- 012_heuristic_surfacing.sql
-- "This rule keeps winning" bookkeeping for learned heuristics: how many
-- times each rule was injected into prompts (use_count) and when it was
-- last surfaced. Feeds skill promotion (Prime /refine: frequent high-
-- confidence rules graduate into pending-skill proposals).
ALTER TABLE learned_heuristics ADD COLUMN use_count INTEGER DEFAULT 0;
ALTER TABLE learned_heuristics ADD COLUMN last_surfaced_at TEXT;
