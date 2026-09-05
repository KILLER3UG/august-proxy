-- Part 27 T1 (privacy): scope-stamp episodic_timeline.
-- The M-2/Part-25 work fenced the facts store with a global∪scope union and
-- scope-stamped episodes (migration 036), but episodic_timeline was left out —
-- and brain_index_snippet injects its last-5 rows into EVERY session's boot
-- <intake> index. Because Bot DM/room turns write the same timeline, a private
-- Bot conversation's last-user-message excerpt surfaced in unrelated global
-- chats (and vice versa). Stamp scope at write time; NULL/'' = global.
ALTER TABLE episodic_timeline ADD COLUMN scope TEXT DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_timeline_scope ON episodic_timeline(scope, timestamp);
