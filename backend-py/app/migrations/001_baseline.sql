-- 001_baseline.sql
-- Baseline migration: captures the existing schema as version 1.
-- This is a no-op for existing databases (all tables use IF NOT EXISTS
-- in memory_schema.py). For fresh databases, ensure_schema() creates
-- everything before migrations run, so this simply records the version.
--
-- Purpose: establish the schema_migrations starting point so future
-- migrations (002+) have a clean version history.

SELECT 1;  -- No-op: schema is managed by memory_schema.ensure_schema()
