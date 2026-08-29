-- Part 17 Phase L (2026-08-29): first-token + prompt-cache telemetry per turn.
-- Latency regressions ("hello takes 60s") were previously unmeasurable —
-- duration_ms alone cannot distinguish a slow first token (cold cache,
-- silent retries) from a long generation. Columns are additive.

-- Time from turn dispatch to the first streamed token, milliseconds.
-- 0 = no token was emitted (error/cancel before first content).
ALTER TABLE turn_outcomes ADD COLUMN ttft_ms INTEGER DEFAULT 0;

-- Prompt-cache accounting for the turn (upstream usage split, tokens).
-- cache_hit 0 + cache_miss 0 = the provider reported no cache fields.
ALTER TABLE turn_outcomes ADD COLUMN cache_hit_tokens INTEGER DEFAULT 0;
ALTER TABLE turn_outcomes ADD COLUMN cache_miss_tokens INTEGER DEFAULT 0;
