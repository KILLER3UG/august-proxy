-- Part 16 §12 fix batch (2026-08-30): separate the tier-1 rubric result
-- from the tier-2 judge verdict. flag_top_slice previously wrote the
-- tier-1 score into judge_verdict, which made run_distiller_pass's
-- "unjudged" selector (empty judge_verdict) always empty — the distiller
-- could never judge a flagged episode (finding F-3).
ALTER TABLE episodes ADD COLUMN tier1_result TEXT;

-- Backfill: any episode whose judge_verdict holds ONLY the tier-1 blob
-- (the F-3 shape) moves it to tier1_result and frees judge_verdict.
UPDATE episodes
SET tier1_result = judge_verdict, judge_verdict = NULL
WHERE judge_verdict LIKE '{"tier1"%'
  AND tier1_result IS NULL;
