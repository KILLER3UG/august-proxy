-- Part 27 E1/C1 (2026-09-05): purge pytest fixtures that leaked into the live
-- stores before conftest isolation was airtight.
--
--  * agent_jobs: the legacy agent-registry job ledger stored as ONE KV JSON
--    blob (44 KB in prod, 29 KB in dev). Its July rows carry
--    "<MagicMock name='mock.model'>" errors — proof tests dispatched registry
--    jobs against the shared dev DB. The live history is subagent_runs; the
--    registry ledger is now an in-memory capped dict, so this key never
--    returns. The durable copy is discarded (same call as 033's auto_memories).
--  * episodes (s1, fp1, bot:alpha): a bot-mode test fixture row that reached
--    the learning corpus. Signature-matched so no real episode can collide.
DELETE FROM memory_store WHERE key = 'agent_jobs';
DELETE FROM episodes WHERE session_id = 's1' AND fingerprint_id = 'fp1';
