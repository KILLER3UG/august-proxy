-- 046: persist the turn verdict + the turn's self-correction counters.
--
-- The loop already DECIDES why it stopped and says so out loud on the stream
-- (``turn_end {reason, rounds}``, workbench.py:5235) and already counts the
-- misbehaviours it self-heals from (``parseFailures``, ``surfaceDowngraded``
-- — workbench.py:3263-3280). Both were ephemeral: the SSE event is gone once
-- the tab closes and the counters are locals that die with the turn
-- coroutine, so "this model hits the output limit every single day" was
-- unauditable — and ``maybe_promote_failure_lesson`` could only ever see
-- ``error_class`` signatures, because the two other failure sources it would
-- need (edit-verification gate misses, guardrail blocks) had no per-turn
-- attribution to count on: ``tool_guardrail_log`` records no model/provider.
--
-- NULL means NOT RECORDED — deliberately no ``DEFAULT 0``. A bare
-- ``ADD COLUMN ... DEFAULT 0`` back-fills every legacy row with a
-- measured-LOOKING zero, and the UI distinguishes measured-zero ("this turn
-- blocked nothing") from unmeasured, so the whole point of the column dies.
-- Rows that predate this migration stay NULL and are labelled as such.
--
-- Consumers: app/services/turn_outcomes.py (writer + ``turn_verdict_stats``),
-- GET /api/brain/turn-outcomes, and the Learning panel
-- (frontend/desktop/src/sections/settings/LearningPanel.tsx). Telemetry only:
-- nothing here is injected into a prompt and nothing gates an answer.

-- Why the managed tool loop ended: finished | length | cap | stall-stop |
-- error | interrupted | awaiting-input — the same vocabulary as turn_end.
ALTER TABLE turn_outcomes ADD COLUMN end_reason TEXT;

-- Rounds the loop ran for this turn (the turn_end ``rounds`` number).
ALTER TABLE turn_outcomes ADD COLUMN rounds INTEGER;

-- Tool-argument payloads that failed to parse across the whole turn — the
-- per-turn total of the counter that used to reset every turn.
ALTER TABLE turn_outcomes ADD COLUMN malformed_tool_args INTEGER;

-- 1 when the turn's tool surface was downgraded to the bare set (A6) after
-- repeated malformed calls, 0 when it was never downgraded.
ALTER TABLE turn_outcomes ADD COLUMN surface_downgraded INTEGER;

-- Trailing streak of failed edit-verification gates at turn close (the
-- session's own ``_verify_state.failStreak``): 0 = the last gate ran and
-- passed, NULL = the gate never ran this turn (no workspace, no edits).
ALTER TABLE turn_outcomes ADD COLUMN edit_verify_fails INTEGER;

-- This turn's guardrail blocks rolled up from tool_guardrail_log as
-- ',tool:count,tool:count,'. The per-block detail stays in that table (single
-- authority); this column only adds the model/provider attribution a lesson
-- signature needs. '' = measured, nothing blocked; NULL = not recorded.
ALTER TABLE turn_outcomes ADD COLUMN guardrail_classes TEXT;
