-- P2 (unified learning scheduler): the learning passes used to ride three
-- independent pollers (introspection loop, consolidation loop, in-turn gates),
-- each keeping its own "did it run?" bookkeeping in an internal_state blob.
-- One scheduler now owns every cadence-driven job and records each run here —
-- one ledger, one due-computation, one place the UI can read.
-- Rows are machine bookkeeping (never user-visible memory), pruned to the
-- recent tail by learning_scheduler._prune.
CREATE TABLE IF NOT EXISTS learning_job_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,               -- registry id ('introspection', 'consolidation')
  started_at TEXT NOT NULL,        -- ISO-8601 UTC
  finished_at TEXT,                -- NULL while a run is in flight
  status TEXT NOT NULL DEFAULT 'running',  -- running | ok | error
  duration_s REAL,
  detail TEXT                      -- summary JSON (counts, error text)
);
CREATE INDEX IF NOT EXISTS idx_learning_job_run_job
  ON learning_job_run(job, id);
