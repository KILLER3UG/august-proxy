-- 022_curation_ledger.sql
-- Unified decision journal for every memory/skill curation actor
-- (reflection loop, sleep cycle, model review, heuristic promotion,
-- skill curator). Round-5 loop unification: one trail instead of three
-- overlapping bookkeeping streams, and the shared record lets each loop
-- see what the others just decided instead of redoing or contradicting it.

CREATE TABLE IF NOT EXISTS curation_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_key TEXT,
    reason TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_curation_ledger_created ON curation_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_curation_ledger_target ON curation_ledger(target_kind, target_key);
