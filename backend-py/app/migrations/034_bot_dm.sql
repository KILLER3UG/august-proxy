-- Part 19 Phase C (2026-09-04, rulings OQ4+OQ8): durable Bot DM inbox.
-- message_agent is the single send path; a DM is an immutable inbox row
-- whose status tracks delivery (pending -> running -> delivered | failed).
-- reason_code is a typed enum so the sender gets an actionable failure
-- receipt (and the retry-once rule can key off it). from_session/to_session
-- route the sender-wake back to the exact chats. Fire-and-forget: the tool
-- enqueues + spawns the delivery task and acks immediately.
CREATE TABLE IF NOT EXISTS bot_dm (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    from_session TEXT DEFAULT '',
    to_session TEXT DEFAULT '',
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending|running|delivered|failed
    reason_code TEXT DEFAULT '',              -- typed failure enum (see dm.REASON_*)
    created_at TEXT DEFAULT (datetime('now')),
    delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_dm_to ON bot_dm(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_bot_dm_from ON bot_dm(from_agent, created_at);
