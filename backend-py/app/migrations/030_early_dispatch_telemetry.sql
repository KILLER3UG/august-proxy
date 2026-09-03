-- Part 18 P3.1 (2026-08-31): early-dispatch measurement, no behavior change.
-- The turn loop diffs the perf mark written when the LAST tool call's
-- arguments finished arriving (mark_tool_args_ready, provider parse sites)
-- against the moment the stream ended — the trailing stream tail early
-- tool dispatch could save. The field rides the Phase L ttft pipeline:
-- persisted on turn_outcomes and emitted in the turnTelemetry SSE event.
-- 0 = the turn had no tool call (or the mark never fired) — nothing to save.
ALTER TABLE turn_outcomes ADD COLUMN tool_args_ready_to_stream_end_ms INTEGER DEFAULT 0;
