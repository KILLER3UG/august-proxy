-- 059: in-place edit history for facts ("now X, previously Y").
--
-- Additive only. An update over an existing key keeps ONE prior value on the
-- row (the value immediately before the latest change, set only when the
-- content actually changed), so an edit reads as a correction with its
-- history attached rather than a silent overwrite. The rollback store holds
-- the undo snapshot; this column is the durable, human- and model-visible
-- record on the row itself.
--
-- The ALTER is tolerated as "already applied" on a database born with the
-- column (the fresh schema is created from memory_schema._CORE_SCHEMA_SQL),
-- and the backfill is a no-op (new rows carry no history), so this file can
-- run twice.

ALTER TABLE facts ADD COLUMN previous_value TEXT DEFAULT '';
