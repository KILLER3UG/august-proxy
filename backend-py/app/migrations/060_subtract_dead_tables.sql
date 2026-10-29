-- 060_subtract_dead_tables.sql
-- Stage-0 subtraction audit ruling (2026-10-30): five tables with no live
-- writer AND no live reader anywhere in backend-py/app are dropped.
--   memory_lifecycle      — created by the deleted migration 002; zero code
--                           references outside that migration.
--   friction_events       — writer removed in the 0.17.0 reorg; the only
--                           remaining reference was the privacy wipe list.
--   consolidation_audit   — same reorg; its replacement surface is the
--                           lifecycle table (/api/brain/consolidation/log).
--   scratchpad            — scratchpad notes moved to session working memory
--                           (system_tools.write_scratchpad); the table never
--                           had an INSERT/SELECT.
--   execution_state       — same move (workbench state blocks); never had an
--                           INSERT/SELECT.
-- All five were verified 0 rows in production and in the pre-migration
-- backup before this migration was written. The deletion was approved by
-- the owner as "DB cleanup steps 1-5" on 2026-10-30.
--
-- Not dropped here: learned_heuristics (converges via
-- memory_schema._drop_empty_legacy_heuristics, kept one release) and
-- harness_trends / curation_ledger / brain_events / session_traces
-- (already dropped by migration 025).

DROP TABLE IF EXISTS memory_lifecycle;
DROP TABLE IF EXISTS friction_events;
DROP TABLE IF EXISTS consolidation_audit;
DROP TABLE IF EXISTS scratchpad;
DROP TABLE IF EXISTS execution_state;
