-- 055: fact lineage + trust signals, and the automation SOURCE stamp.
--
-- Why a .sql file and not code: every statement here is a PURE ADDITIVE
-- ALTER (a new column) or a CREATE INDEX IF NOT EXISTS. Nothing rebuilds a
-- table, nothing rewrites rows, so there is no half-applied state for the
-- runner's executescript to commit. The trap documented in
-- `memory_schema._ensure_fact_scope_key` is about a REBUILD in a .sql file
-- (DROP + RENAME): executescript commits the open transaction before it
-- runs, and the runner's own failure bookkeeping commits again, so a
-- half-applied rebuild can be committed by the runner treating the failure
-- as bookkeeping. An additive ALTER has no such middle state — it either
-- applied or it did not.
--
-- A second reader of the runner should know this: `conn.executescript`
-- ABORTS at the first failing statement, and the runner then records the
-- version as applied even though the REST of the script never ran. The
-- `ensure_column` fast path (`memory_schema._ensure_fact_signal_columns`)
-- owns the SAME columns and runs on every boot, so on a warm database this
-- file's first ALTER fails with "duplicate column name" and the remaining
-- statements are skipped — harmlessly, because the fast path already added
-- every column named below. That helper is the GUARANTEE (it runs on both
-- paths of `ensure_schema`); this file is the numbered RECORD and the
-- cold-path owner.
--
-- The `ensure_column` fast path in `memory_schema.ensure_schema` owns the
-- same columns, and the runner treats "duplicate column name" as
-- already-applied (the 044 `facts.description` precedent), so the double
-- ownership is harmless.
--
-- ── facts: supersession lineage (M-3) ────────────────────────────────────
-- `superseded_by` — the fact_key of the fact that replaced this row.
-- `supersedes`    — a JSON array of the fact_keys this row replaced.
-- The loser row is KEPT (status flips to 'superseded'), so both sides can
-- be written and the lineage is queryable: the Memory UI can show "replaces
-- X" and a forget on the winner can offer to restore the losers.
-- NULL on both sides means "this row is not part of a supersession" — the
-- column was added after the fact was written, which is NOT the same as
-- "this fact superseded nothing", so it is never back-filled.
--
-- ── facts: the negative recall signal (M-7) ─────────────────────────────
-- `injected_count`  — how many times this fact has been INJECTED into a
-- turn's context. A fact that is injected again and again and never quoted
-- is a stale-but-plausible entry holding rank.
-- `last_injected_at`— when it was last injected (NULL = never, or not
-- recorded).
-- The count starts at 0, not NULL: "injected zero times since the column
-- existed" is a true statement about a row written after this migration,
-- and the disuse penalty is computed from the difference, so a NULL would
-- need a second "unknown" branch in the scorer.
--
-- ── facts: verification + contradiction flags (M-8) ─────────────────────
-- `verified_at` — when the fact was last re-stated by the user. An UPDATE
-- is not a verification, so the two are separate columns and the column
-- only moves when a human (or a turn the user confirmed) re-states the
-- fact. NULL = never verified (the honest default for every row written
-- before this migration).
-- `contradicts` — the fact_key of the entry this one conflicts with. A
-- conflict is NOT a supersession: the plan's ruling is that a
-- same-title-different-body pair is CONTESTED (status='contested') and
-- waits for a human, rather than being silently superseded.
--
-- ── episodes / turn_outcomes: the source stamp (M-12) ───────────────────
-- `episodes` gained a `scope` column in 036 — a scope is "whose memory is
-- this?", and a source is "what produced this?". The source stamp is the
-- missing half: an episode (or a turn) produced by an AUTOMATION run is
-- repetitive by design, and without a stamp it dominates the mining and
-- recurrence meters the way a user's own repetition does.
-- NULL = not recorded (every row written before this migration, and a
-- writer that never learned the column). It is never '' and never
-- back-filled: a row that was written before the column existed was not
-- measured as an automation row.

ALTER TABLE facts ADD COLUMN superseded_by TEXT;
ALTER TABLE facts ADD COLUMN supersedes TEXT DEFAULT '[]';
ALTER TABLE facts ADD COLUMN injected_count INTEGER DEFAULT 0;
ALTER TABLE facts ADD COLUMN last_injected_at TEXT;
ALTER TABLE facts ADD COLUMN verified_at TEXT;
ALTER TABLE facts ADD COLUMN contradicts TEXT;

ALTER TABLE episodes ADD COLUMN source TEXT;
ALTER TABLE turn_outcomes ADD COLUMN source TEXT;

CREATE INDEX IF NOT EXISTS idx_facts_superseded_by ON facts(superseded_by);
CREATE INDEX IF NOT EXISTS idx_facts_contradicts ON facts(contradicts);
CREATE INDEX IF NOT EXISTS idx_episodes_source ON episodes(source);
