-- 052: quarantine the episodes the prose detector invented (backlog item 5).
--
-- Until 2c8f6ac7 a tool_error event came from matching "[Validation Error]",
-- "traceback" or "exit code:N" anywhere in assistant or tool text. A tool
-- result that merely QUOTED that vocabulary therefore mined as a failure — and
-- the string it quotes lives in skills/august-harness/SKILL.md, the skill that
-- documents the error receipts. Measured on the development database: 41
-- failure_recovery episodes, all 41 carrying a tool_error event, and 0 messages
-- in the whole store carrying an error receipt. Every one was invented.
--
-- They are marked, not deleted. The rows are the audit trail for how the loop
-- escalated, and the retention pass already bounds their lifetime. What changes
-- is that nothing that ACTS on an episode can see them: the tier-1 scorer, the
-- tier-2 judge selector, the same-cause count that feeds `causeStability`, and
-- the learning counters. `episode_miner.quarantine_unverified_tool_errors`
-- writes this flag and is re-run at the head of every mining pass.

ALTER TABLE episodes ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_episodes_quarantined ON episodes(quarantined);
