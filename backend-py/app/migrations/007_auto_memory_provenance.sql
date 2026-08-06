-- 007_auto_memory_provenance.sql
-- Which conversation produced each auto-memory (provenance loop for the
-- "what August learned here" surface, mirroring learned_heuristics).
ALTER TABLE auto_memories ADD COLUMN source_session_id TEXT;
