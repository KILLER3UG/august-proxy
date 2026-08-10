-- 011_routing_outcome.sql
-- Graded turn outcomes (error | refusal | thinking_only | tool_error |
-- verified | ok) so routing evidence reflects task SUCCESS, not just
-- error-absence. Old rows keep NULL outcome; the workbench writes a grade
-- for every new turn.
ALTER TABLE routing_evidence ADD COLUMN outcome TEXT;
