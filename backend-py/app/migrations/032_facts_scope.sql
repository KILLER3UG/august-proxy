-- Part 21 M-2 (2026-09-04, ruling OQ5): scope axis on facts.
-- One column makes memory home-based instead of one-global-pile: a Bot's
-- canonical chat (and its DM/room run contexts) write 'bot:<agentId>' rows;
-- everything else stays 'global'. Retrieval unions global ∪ this-scope, so
-- a Bot still sees the user's shared memory but its private notes stay
-- private. Additive + reversible: every existing row keeps DEFAULT 'global'.
-- The index rides (scope, status) because every retrieval filter is
-- scope-union AND status-active.
ALTER TABLE facts ADD COLUMN scope TEXT DEFAULT 'global';
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope, status);
