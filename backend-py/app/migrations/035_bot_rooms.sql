-- Part 19 Phase D (2026-09-04, ruling OQ3 + Part 22 G-1/G-2): group rooms.
-- A room is a client-owned ordered log (NOT an LLM router): 2-6 member Bots
-- deliberate in deterministic serial rounds driven by rooms.py.
--   bot_room          — the roster + the needs-you badge (G-2 escalation)
--   bot_room_message  — the shared log; kind distinguishes a member turn from
--                       a pass, a review request, a verdict, and an escalation
--                       row, so the driver + the UI read one table.
CREATE TABLE IF NOT EXISTS bot_room (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    members TEXT NOT NULL DEFAULT '[]',   -- JSON array of agent ids (2-6)
    needs_you INTEGER NOT NULL DEFAULT 0, -- G-2: stuck room badge (registry flag)
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bot_room_message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    sender_agent TEXT NOT NULL,           -- agent id, or 'user'
    body TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message', -- message|pass|review|verdict|escalation
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_room_msg_room ON bot_room_message(room_id, id);
