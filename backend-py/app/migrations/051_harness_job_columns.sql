-- 051: the three harness columns that were being added at RUNTIME (2026-10-02).
--
-- `harness_jobs.outcomes_json` and `harness_routines.{schedule,paused,last_run}`
-- were each introduced by an `ALTER TABLE ... ADD COLUMN` executed on every
-- connection inside a `try/except Exception: pass`. Three problems, all of them
-- invisible from the outside:
--
--   * a failed DDL was swallowed, so the column was silently absent and every
--     writer that assumed it failed later, far from the cause;
--   * the change was invisible to the migration runner, so `schema_migrations`
--     did not record it and an upgrade path did not exist for a user whose DB
--     predates the code that needs the column;
--   * it ran on EVERY connection rather than once per upgrade.
--
-- `ALTER TABLE ... ADD COLUMN` is exactly what migrations are for, and the
-- runner treats 'duplicate column name' / 'already exists' as
-- already-applied (see `_ALREADY_APPLIED_ERRORS` in app/lib/migrations.py), so
-- an installation whose DB already got these columns from the old runtime
-- path upgrades cleanly and simply records the version.
--
-- No data backfill: every column is additive with a default, and the runtime
-- readers already treat a NULL/'' as "never recorded".

ALTER TABLE harness_jobs ADD COLUMN outcomes_json TEXT DEFAULT '{}';
ALTER TABLE harness_routines ADD COLUMN schedule TEXT DEFAULT '';
ALTER TABLE harness_routines ADD COLUMN paused INTEGER DEFAULT 0;
ALTER TABLE harness_routines ADD COLUMN last_run TEXT DEFAULT '';