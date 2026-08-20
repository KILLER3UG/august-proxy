-- 021_subagent_full_result.sql
-- Hermes-style well-structured harness: full result blob for drawer
-- Previously only 4000-char result_summary was kept; long Markdown final
-- responses were clipped. Keep full text for perfect drawer rendering and
-- live-transcript replay, while summary stays truncated for list views.

ALTER TABLE subagent_runs ADD COLUMN result_full TEXT DEFAULT '';
ALTER TABLE subagent_runs ADD COLUMN last_activity_at TEXT;
ALTER TABLE subagent_runs ADD COLUMN api_calls INTEGER DEFAULT 0;
