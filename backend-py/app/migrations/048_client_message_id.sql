-- 048: client-authored message identity for rich transcript sync.
--
-- Migration 047 made the STRUCTURED timeline durable (`messages.blocks_json`),
-- but the desktop still owns the block timeline: it authors tool cards,
-- reasoning blocks, attachments and inline cards that the backend's own
-- transcript row cannot derive. Syncing them back needs a stable join key
-- that survives the workbench save, which re-writes the whole `messages`
-- table (DELETE + re-INSERT) on every durability barrier.
--
-- `client_message_id` is that key:
--
--   * The desktop mints the id (`m<ts>` for a user bubble, `a<ts>` for the
--     assistant turn) and sends it as `clientMessageId` on
--     POST /api/sessions/{id}/messages. The row keeps it forever after.
--   * The workbench snapshot writer re-attaches the id (and the client's
--     `blocks_json`) to the matching message when it rewrites the table, so
--     a later PATCH enrichment still finds the same row.
--   * NULL on every pre-048 row: absence means "no client identity", and
--     such a row is still enriched by position/content as before.
--
-- The index is UNIQUE per session (partial, NULLs excluded) so the POST upsert
-- is idempotent: replaying the same client id converges on one row instead of
-- appending a duplicate bubble to the transcript.
--
-- The FTS update trigger is NARROWED to the indexed columns. 047's
-- `AFTER UPDATE ON messages` fired on every UPDATE — including the
-- blocks-only enrichment write — re-indexing the same text (a delete+insert
-- pair in the FTS content-sync table) for a payload the search index does not
-- even contain. `AFTER UPDATE OF content, session_id, role` keeps the
-- content-sync contract for real text changes and makes enrichment provably
-- FTS-neutral.

ALTER TABLE messages ADD COLUMN client_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
    ON messages(session_id, client_message_id)
    WHERE client_message_id IS NOT NULL;

DROP TRIGGER IF EXISTS messages_fts_au;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF content, session_id, role ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, session_id, role)
    VALUES('delete', old.id, old.content, old.session_id, old.role);
    INSERT INTO messages_fts(rowid, content, session_id, role)
    VALUES (new.id, new.content, new.session_id, new.role);
END;
