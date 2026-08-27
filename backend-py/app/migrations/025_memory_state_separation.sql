-- 025_memory_state_separation.sql
-- Memory / machine-state separation (plan §2.1, audit 2026-08-27).
--
-- The 0.17.0 reorg (4f1bfdb1) deleted the cognitive writers (consolidation
-- daemon, vector mirror, auto-review loop, heuristics writer, context
-- builder) but left their persisted state behind. Migration 023's comment
-- claimed boot_maintenance_state / auto_memory_review_state / cognitive:*
-- were "written by live code" — that was FALSE (verified 2026-08-27: zero
-- live writers in the working tree). This migration removes the orphaned
-- state, the immutable legacy turn-lessons, and the tables with no live
-- readers.
--
-- Keep-list (NOT touched): agent_jobs / agents:* KV (live registry),
-- routing_evidence, execution_state, scratchpad, exams (live readers).

-- 1. Dead-daemon KV state (writers deleted in 4f1bfdb1; 023's ALIVE note wrong).
DELETE FROM memory_store WHERE key IN (
  'cognitive:consolidation:last_run',
  'cognitive:vector_reconciliation:last_run',
  'boot_maintenance_state',
  'auto_memory_review_state',
  'routing:auto-route:decisions',
  'self_evolution_log',
  'userProfile'
);

-- 2. Immutable legacy turn-lessons (writer deleted; nothing reads them into
--    prompts; the UI is forbidden from deleting them — brain.py 403). The
--    failure mode they encode is not actionable memory (plan §3.6).
DELETE FROM learned_heuristics WHERE source = 'turn-lesson';

-- 3. Dead tables (0 live readers verified by grep of backend-py/app, 2026-08-27).
DROP TABLE IF EXISTS curation_ledger;
DROP TABLE IF EXISTS session_traces;
DROP TABLE IF EXISTS harness_trends;
DROP TABLE IF EXISTS vector_entries;
DROP TABLE IF EXISTS graph_entities;
DROP TABLE IF EXISTS graph_relations;
DROP TABLE IF EXISTS graph_observations;

-- 4. brain_events (Q8 ruling 2026-08-27): schema-only reader, zero harness
--    consumers confirmed. Dropped here rather than 023 because 023 already
--    ran on existing installs and the runner never re-executes applied versions.
DROP TABLE IF EXISTS brain_events;
