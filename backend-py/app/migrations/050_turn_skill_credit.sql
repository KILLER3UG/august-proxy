-- 050: skill/fact credit assignment on the turn ledger (audit D1, 2026-09-26).
--
-- ``harness_outcome`` measured approved proposals; nothing measured the
-- SKILLS that rode in a turn's prompt — ``record_skill_use`` counts loads
-- only, with no link to how the turn ended. Four additive columns close that
-- gap, all following the 046 honesty rule: NULL = not recorded (pre-050 rows,
-- or a writer that never learned the column), '[]' = measured and empty.
--
--   skills_injected  JSON array — skill names whose descriptions rode in the
--                    per-turn <relevant_skills> tail this turn
--   skills_loaded    JSON array — skills actually loaded via load_skill
--                    during the turn (the load counter stays the
--                    lifecycle's authority; this adds the turn link)
--   facts_injected   JSON array — memory fact keys injected in the tail
--   error_families   JSON array — error families the loop's steering scan
--                    saw this turn (union of the per-round windows). Written
--                    in the SAME vocabulary as guardrail_classes (the
--                    shared enum in app/services/error_families.py), which
--                    is what makes the guardrail column joinable.
--
-- There is deliberately NO separate skill_evidence table: the suggestions
-- read (GET /api/brain/skills/suggestions) aggregates these rows read-time
-- with json_each — the routing_evidence pattern (event rows + read-time
-- win-rates), not a second writer to keep in sync.

ALTER TABLE turn_outcomes ADD COLUMN skills_injected TEXT;
ALTER TABLE turn_outcomes ADD COLUMN skills_loaded TEXT;
ALTER TABLE turn_outcomes ADD COLUMN facts_injected TEXT;
ALTER TABLE turn_outcomes ADD COLUMN error_families TEXT;
