-- 053: the decision ledger + the join key the other ledgers never had.
--
-- Two problems this closes, both measured on 2026-10-17:
--
-- 1. FIVE records of the same turn, no key between them. `turn_outcomes`
--    (verdict, rounds), `usage_events` (tokens, cache split), `routing_evidence`
--    (ok, tokens, prompt), `subagent_runs`, and `episodes` each describe a turn
--    and none of them can be joined to another. Cost is not stored anywhere —
--    it is priced at read time by `cost_estimator.price_for_model` — so
--    "which tool wastes the most money per success" has no query that answers
--    it. `usage_events.turn_id` is that key: additive, nullable, and NULL means
--    "written before this migration or by a caller that had no turn", exactly
--    the 046 honesty rule.
--
-- 2. The harness never recorded its own DECISIONS, only their aggregate
--    outcome. `harness_outcome` compares 14 days before an applied proposal
--    against 14 days after over ALL episodes, with no control arm and no
--    per-decision attribution, so a quiet fortnight reads as "improved".
--    `decision_ledger` is one row per decision: the thesis, the alternatives
--    that were considered and rejected (the counterfactual), the confidence,
--    the observable that would settle it, the cost, and — once the daily
--    `journal` job has run — the outcome and a Brier component.
--
-- Deliberately NOT facts. A ledger row is evidence about a decision, not a
-- belief about the world: it must never be injected into a prompt as memory.
-- Lessons still reach the model through the gated `apply_verdict` door.
--
-- `status`: open | resolved | expired | unscorable. `unscorable` is
-- first-class on purpose — the episode miner's last unmeasured detector
-- invented 41 of 41 findings, and a resolver that always produces a verdict is
-- how that happens. `outcome` is -1..1 (or 0/1 for binary decisions); NULL
-- until resolved.

CREATE TABLE IF NOT EXISTS decision_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL DEFAULT (datetime('now')),
    session_id    TEXT,
    turn_id       INTEGER,
    kind          TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'mechanical',
    chosen        TEXT NOT NULL,
    alternatives  TEXT,
    thesis        TEXT,
    observable    TEXT,
    confidence    REAL,
    horizon_turns INTEGER,
    due_at        TEXT,
    cost_usd      REAL,
    tokens_in     INTEGER,
    tokens_out    INTEGER,
    status        TEXT NOT NULL DEFAULT 'open',
    outcome       REAL,
    resolved_at   TEXT,
    evidence      TEXT,
    model         TEXT,
    provider      TEXT,
    prompt_hash   TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_open ON decision_ledger(status, due_at);
CREATE INDEX IF NOT EXISTS idx_decision_turn ON decision_ledger(turn_id);
CREATE INDEX IF NOT EXISTS idx_decision_ts ON decision_ledger(ts);

-- The join key. `turn_outcomes.id` is the hub: every other per-turn table can
-- now be aggregated against the turn's verdict.
ALTER TABLE usage_events ADD COLUMN turn_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_usage_turn ON usage_events(turn_id);
