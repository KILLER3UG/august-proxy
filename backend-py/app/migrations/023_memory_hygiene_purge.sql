-- 023_memory_hygiene_purge.sql
-- One-time purge of memory-store noise (audit 2026-08-26):
--
--   1. auto_memories written by the DELETED extraction writer
--      (services/memory/auto_memory.py was removed in 4f1bfdb1): broken
--      corrections ("User prefers: works/you/think"), duplicated "hi" episode
--      dumps, per-turn conv summaries, raw tool-failure JSON. Nothing in the
--      live tree reads or writes this table anymore.
--   2. session_context:* KV snapshots — the writer (save_kv in the chat turn)
--      was removed in the same commit; the keys are orphaned (194 of them,
--      many from deleted golden-eval runs).
--   3. harness_eval:* / heuristic_trail:* / current_context — writers also
--      deleted with the golden-eval suite.
--
-- Machine state that is ALIVE stays: boot_maintenance_state,
-- auto_memory_review_state, cognitive:*last_run (written by live code).
-- Timeline 'user activity' heartbeat rows are deleted here too; the writer
-- was a no-op'd function as of the same audit.

-- 2.8 (Part 25): the `DELETE FROM auto_memories;` that led this file is REMOVED.
-- Part 21 OQ1 (migration 033) retired the table and create_core_schema no longer
-- creates it, so on every FRESH DB this DELETE raised "no such table" and —
-- because executescript aborts on the first error — silently skipped the three
-- purges below. 033 drops the table (and its rows) outright, so purging it here
-- is moot; removing the statement lets the KV/timeline/heuristic purges run.

DELETE FROM memory_store
WHERE key LIKE 'session_context:eval_%'
   OR key LIKE 'harness_eval:%'
   OR key LIKE 'heuristic_trail:%'
   OR key = 'current_context'
   OR key LIKE 'session_context:%';

DELETE FROM episodic_timeline WHERE event_summary = 'user activity' AND category = 'activity';

-- Stale learned rule: asserts a verifier gate that was removed 2026-08-24
-- (AGENTS.md: "No verifier gate exists"). Re-injecting it would lie to models.
DELETE FROM learned_heuristics WHERE rule LIKE '%Verifier gate%';
