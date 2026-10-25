-- 057: goal environments — the harness as the place the agent works.
--
-- Additive only, and idempotent: the same DDL is added to `create_extended_tables` so a database
-- born after this file gets the tables from the fresh path, and this file brings an older one
-- forward. Nothing here is a second store: goals live in the brain SQLite beside `facts`, so the
-- existing backup, integrity check and restore path already cover them.
--
-- A goal's `bound` is JSON ({allow, deny, maxRounds, contextChars}); a movement is a row including
-- the refusals (ok = 0), because a blocked write that leaves no trace is a blocked write the model
-- repeats. There is deliberately NO trigger table: this repo already wakes work through jobs and
-- routines, and a second trigger store would be a parallel system.

CREATE TABLE IF NOT EXISTS goal_envs (
    id           TEXT PRIMARY KEY,
    parent_id    TEXT,
    title        TEXT NOT NULL,
    goal         TEXT NOT NULL,
    inputs       TEXT NOT NULL DEFAULT '[]',
    outputs      TEXT NOT NULL DEFAULT '[]',
    bound        TEXT NOT NULL DEFAULT '{"allow":[],"deny":[],"maxRounds":0,"contextChars":0}',
    status       TEXT NOT NULL DEFAULT 'active',
    owner        TEXT NOT NULL DEFAULT 'agent',
    version      INTEGER NOT NULL DEFAULT 1,
    depth        INTEGER NOT NULL DEFAULT 0,
    close_reason TEXT NOT NULL DEFAULT '',
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_envs_parent ON goal_envs(parent_id);
CREATE INDEX IF NOT EXISTS idx_goal_envs_status ON goal_envs(status);

CREATE TABLE IF NOT EXISTS goal_runs (
    id         TEXT PRIMARY KEY,
    env_id     TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    bot_id     TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'running',
    round      INTEGER NOT NULL DEFAULT 0,
    model      TEXT NOT NULL DEFAULT '',
    reason     TEXT NOT NULL DEFAULT '',
    started_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_runs_env ON goal_runs(env_id);
CREATE INDEX IF NOT EXISTS idx_goal_runs_session ON goal_runs(session_id, status);

CREATE TABLE IF NOT EXISTS goal_artifacts (
    id          TEXT PRIMARY KEY,
    env_id      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    ref         TEXT NOT NULL,
    summary     TEXT NOT NULL,
    produced_by TEXT NOT NULL,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_artifacts_env ON goal_artifacts(env_id);

CREATE TABLE IF NOT EXISTS goal_movements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id TEXT NOT NULL,
    at          REAL NOT NULL,
    actor       TEXT NOT NULL,
    from_env    TEXT NOT NULL,
    to_env      TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    reason      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_goal_movements_artifact ON goal_movements(artifact_id, id);

CREATE TABLE IF NOT EXISTS goal_claims (
    id                 TEXT PRIMARY KEY,
    env_id             TEXT NOT NULL,
    text               TEXT NOT NULL,
    about_artifact_id  TEXT NOT NULL DEFAULT '',
    made_by            TEXT NOT NULL,
    made_at            REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_claims_env ON goal_claims(env_id);

CREATE TABLE IF NOT EXISTS goal_marks (
    id       TEXT PRIMARY KEY,
    env_id   TEXT NOT NULL,
    claim_id TEXT NOT NULL,
    text     TEXT NOT NULL,
    verdict  TEXT NOT NULL,
    evidence TEXT NOT NULL,
    by       TEXT NOT NULL,
    at       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_marks_claim ON goal_marks(claim_id);
