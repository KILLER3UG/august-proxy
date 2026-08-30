-- Part 16 Phase A (2026-08-30): episodes + failure fingerprints.
-- The self-improvement loop's raw material: failure→recovery, correction→
-- accepted, and abandoned-approach windows mined deterministically from
-- stored transcripts (messages) + turn telemetry (turn_outcomes). No
-- runtime change to the chat loop. 027 is taken by Part 17 Phase L.

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  kind TEXT,                 -- failure_recovery | correction_accepted | abandoned_approach
  start_message_id INTEGER, end_message_id INTEGER,
  events TEXT,               -- JSON: typed event list with tool/outcome/excerpt
  outcome TEXT,              -- resolved | unresolved | rescued
  fingerprint_id TEXT,
  tier INTEGER DEFAULT 1,    -- 1 scored | 2 judged
  judge_verdict TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failure_fingerprints (
  fingerprint TEXT PRIMARY KEY,  -- normalized signature, e.g. missing-binary:ngspice
  episode_count INTEGER DEFAULT 1,
  first_seen TEXT,
  last_seen TEXT,
  flagged INTEGER DEFAULT 0,     -- promoted to tier 2
  status TEXT                    -- open | skill_drafted | resolved | retired
);

CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_fingerprint ON episodes(fingerprint_id);
CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
CREATE INDEX IF NOT EXISTS idx_fingerprints_flagged ON failure_fingerprints(flagged);
