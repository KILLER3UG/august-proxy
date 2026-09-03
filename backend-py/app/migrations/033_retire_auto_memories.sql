-- Part 21 OQ1 (2026-09-04 ruling): retire the auto_memories store.
-- No live writer existed (saveAutoMemory is dead code); the table already
-- 404s through _BRAINStores; production's rows were stale conv_summary_wb_*
-- junk. The privacy export is the documented preservation path — anyone who
-- wanted these rows could export them — so we DISCARD rather than migrate
-- (migrating would seed the facts BM25 corpus with noise). create_core_schema
-- no longer creates the table/triggers; this migration removes them from
-- legacy DBs. DROP IF EXISTS is idempotent; every reader is table-existence
-- guarded, so a fresh DB (never had it) and a legacy DB both land clean.
DROP TABLE IF EXISTS auto_memories_fts;
DROP TABLE IF EXISTS auto_memories;
