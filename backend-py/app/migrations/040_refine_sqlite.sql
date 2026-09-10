-- Part 22 (harness architecture): the refine store moves from a directory of
-- JSON files (dataDir/refine_store/entries/*.json + ledger.jsonl) into the
-- brain DB, joining episodes/facts/outcomes where the learning loop already
-- lives. The JSON *shape* of each entry (including its version list) is
-- preserved verbatim in `doc` — the module's public API is unchanged; only
-- the container is. Structured columns exist so SQL can filter scope/kind
-- without parsing every doc, and so the privacy wipe (routers/privacy.py)
-- and DB-level backup cover the store like every other learning table.
-- First-use import: refine_store copies pre-existing entries/ledger from
-- the old directory into these tables once, then renames the directory to
-- refine_store.migrated (visible, idempotent, nothing silently lost).
CREATE TABLE IF NOT EXISTS refine_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  session_id TEXT DEFAULT '',
  updated_at TEXT DEFAULT '',
  doc TEXT NOT NULL                 -- full entry JSON (versions list included)
);
CREATE INDEX IF NOT EXISTS idx_refine_entries_scope ON refine_entries(scope, updated_at);

CREATE TABLE IF NOT EXISTS refine_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT,
  actor TEXT,
  action TEXT,
  entry_id TEXT DEFAULT '',
  target_key TEXT DEFAULT '',
  kind TEXT DEFAULT '',
  scope TEXT DEFAULT '',
  detail TEXT DEFAULT '',
  raw TEXT                          -- the full row JSON, forward-compat
);
CREATE INDEX IF NOT EXISTS idx_refine_ledger_at ON refine_ledger(at);
