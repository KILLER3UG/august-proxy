-- P5 (harness architecture): the outcome ledger. Every side-effecting
-- learning-loop write — an approved harness proposal (deterministic applier)
-- or a kept refine entry — gets one row here so a later scheduled pass can
-- answer the only question the loop never asked: did the change actually
-- help? `key` is stable and unique (source + id[:version]), so recording is
-- idempotent and the measurement job never double-books a write.
--
-- before this table existed, proposals recorded `expectedOutcome`
-- and nothing ever checked it — the number that closes the self-improvement
-- loop was missing (paired pre/post eval, the SkillsBench protocol at
-- proposal scale).
CREATE TABLE IF NOT EXISTS harness_outcome (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,               -- 'proposal' | 'refine'
  kind TEXT NOT NULL DEFAULT '',      -- brain_config | skill_* | promote | prompt_note | memory ...
  target TEXT NOT NULL DEFAULT '',    -- skill name / config keys / refine entry id
  fingerprint TEXT NOT NULL DEFAULT '',  -- targeted failure fingerprint ('' = whole-corpus measurement)
  applied_at TEXT NOT NULL,           -- ISO 'YYYY-MM-DD HH:MM:SS' UTC (SQLite datetime space form)
  expected TEXT NOT NULL DEFAULT '',  -- the change's own expectedMetric/expectedOutcome
  -- written by the outcome-measurement job once the window is long enough:
  measured_at TEXT,
  window_d INTEGER,
  before_json TEXT,                   -- {'episodeRate': r, 'fingerprintRecurrence': n, ...}
  after_json TEXT,                    -- same shape
  verdict TEXT                        -- 'improved' | 'flat' | 'regressed' | 'insufficient'
);
CREATE INDEX IF NOT EXISTS idx_harness_outcome_pending
  ON harness_outcome(measured_at, applied_at);
