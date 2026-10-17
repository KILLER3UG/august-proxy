-- 054: persist what the distiller's door DID with a verdict.
--
-- `episodes.judge_verdict` stores the judge's raw JSON — what a model said.
-- Nothing stored what the door then decided, because `apply_verdict` returns
-- its label and every caller throws it away: consolidation keeps only
-- `{'verdicts', 'skipped'}` (consolidation.py:794), and the review job reduces
-- `results` to a `kept` count (learning_scheduler._review_job).
--
-- The consequence is that the distiller's precision is unfalsifiable. "How
-- often is a `memory` verdict dropped as a duplicate or junk?" has no answer,
-- so `record_precision_run` still has no production caller, so
-- `amendBodyEnabled` is false forever and every `amend_body` verdict
-- downgrades. This column is the join those questions need.
--
-- NULL means "no verdict was applied for this episode" (or a row written
-- before 054). It is never back-filled: an old row with a measured-looking
-- label is exactly what the 046 comment warns about.

ALTER TABLE episodes ADD COLUMN applied_label TEXT;

CREATE INDEX IF NOT EXISTS idx_episodes_applied_label ON episodes(applied_label);
