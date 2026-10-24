-- 056: the main-goal fact record shape.
--
-- Additive only. The chat agent's tag is server-derived from its code path
-- (source), never a model argument; aliases are optional recall hooks; the
-- sensitive flag is a durable copy of the write-door detector so a read door
-- can filter without re-running the regex; derived_from is the edge `forget`
-- follows to delete a dependent that has no other parent.
--
-- The ALTERs are tolerated as "already applied" on a database born with the
-- columns (the fresh schema is created from memory_schema._CORE_SCHEMA_SQL),
-- and the backfills are idempotent so this file can run twice.

ALTER TABLE facts ADD COLUMN aliases TEXT DEFAULT '[]';
ALTER TABLE facts ADD COLUMN subject_type TEXT DEFAULT '';
ALTER TABLE facts ADD COLUMN tag TEXT DEFAULT '';
ALTER TABLE facts ADD COLUMN source_session TEXT DEFAULT '';
ALTER TABLE facts ADD COLUMN sensitive INTEGER DEFAULT 0;
ALTER TABLE facts ADD COLUMN version INTEGER DEFAULT 1;
ALTER TABLE facts ADD COLUMN derived_from TEXT DEFAULT '[]';

-- Backfill existing rows from the two fields that already encode the answer.
UPDATE facts SET tag = CASE
    WHEN source IN ('user', 'model', '') THEN 'stated'
    WHEN source = 'harness' OR source LIKE 'promoted-from:%' THEN 'inferred'
    WHEN source = 'bench' OR source LIKE 'imported%' THEN 'observed'
    ELSE 'inferred'
  END
  WHERE tag IS NULL OR tag = '';

UPDATE facts SET subject_type = CASE
    WHEN kind = 'profile' THEN 'profile'
    WHEN kind = 'preference' THEN 'preference'
    WHEN kind = 'person' OR category = 'person' THEN 'person'
    WHEN kind = 'project' OR category = 'project' THEN 'area'
    ELSE 'topic'
  END
  WHERE subject_type IS NULL OR subject_type = '';

UPDATE facts SET aliases = '[]' WHERE aliases IS NULL OR aliases = '';
UPDATE facts SET derived_from = '[]' WHERE derived_from IS NULL OR derived_from = '';
UPDATE facts SET version = 1 WHERE version IS NULL OR version < 1;
