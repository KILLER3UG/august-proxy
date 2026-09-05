-- Part 27 F4: room threads. A room holds multiple threads; each top-level
-- user post is a thread root and every member turn / reply inherits its
-- thread_id, so "Reply in thread" scopes the next round to that thread's
-- history instead of dragging in unrelated threads. NULL is back-filled to
-- each row's own id (legacy single-thread rooms stay intact).
ALTER TABLE bot_room_message ADD COLUMN thread_id INTEGER;
UPDATE bot_room_message SET thread_id = id WHERE thread_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_room_msg_thread ON bot_room_message(room_id, thread_id, id);
