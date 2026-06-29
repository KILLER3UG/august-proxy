"""
Auto-memory — automatically saves and retrieves relevant memory context.

Port of backend/services/memory/auto-memory.js + background-review.js.
Phase 0 rewrite: writes individual FTS-indexed rows to the `auto_memories`
table instead of a JSON blob under one key in `memory_store`.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from app.services.memory_store import save_memory, get_memory

_MAX_MEMORIES = 100


# ── Direct DB helpers (bypass memory_store key-value layer) ──────────────


def _conn():
    """Get the thread-local brain DB connection."""
    from app.services.memory_store import _conn as get_conn
    return get_conn()


# ── CRUD ────────────────────────────────────────────────────────────────


def save_auto_memory(key: str, content: Any, category: str = "auto", importance: float = 0.5) -> None:
    """Save an automatically captured memory as an individual FTS-indexed row.

    The FTS5 triggers on `auto_memories` (created in Phase 0) automatically
    keep `auto_memories_fts` in sync — no manual FTS insert needed.
    """
    conn = _conn()
    now = __import__("datetime").datetime.utcnow().isoformat() + "Z"
    content_json = content if isinstance(content, str) else json.dumps(content)

    # Try to update an existing entry with the same key
    existing = conn.execute(
        "SELECT id FROM auto_memories WHERE key = ?", (key,)
    ).fetchone()
    if existing:
        conn.execute(
            "UPDATE auto_memories SET content = ?, importance = ?, updated_at = ? WHERE id = ?",
            (content_json, importance, now, existing["id"]),
        )
    else:
        conn.execute(
            "INSERT INTO auto_memories (key, content, category, importance, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (key, content_json, category, importance, now),
        )

    # Trim to max rows (delete lowest-importance, oldest-first for ties)
    conn.execute("""
        DELETE FROM auto_memories WHERE id NOT IN (
            SELECT id FROM auto_memories ORDER BY importance DESC, id DESC LIMIT ?
        )
    """, (_MAX_MEMORIES,))
    conn.commit()


def get_relevant_memories(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Find memories relevant to a query using FTS5 ranking.

    Falls back to LIKE-based search if FTS returns nothing.
    """
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT key, content, category, importance, created_at "
            "FROM auto_memories_fts "
            "WHERE content MATCH ? "
            "ORDER BY rank "
            "LIMIT ?",
            (query, limit),
        ).fetchall()
        if rows:
            result = []
            for r in rows:
                item = dict(r)
                # Try to parse content as JSON if it looks like one
                try:
                    item["content"] = json.loads(item["content"])
                except (json.JSONDecodeError, TypeError):
                    pass
                result.append(item)
            return result
    except Exception:
        pass

    # FTS fallback: LIKE-based
    all_rows = conn.execute(
        "SELECT key, content, category, importance, created_at FROM auto_memories"
    ).fetchall()
    scored = []
    q = query.lower()
    for r in all_rows:
        score = 0.0
        key = str(r["key"] or "").lower()
        content = str(r["content"] or "").lower()
        if q and q in key:
            score += 0.5
        if q and q in content:
            score += 0.3
        score += r["importance"] * 0.2
        if score > 0:
            item = dict(r)
            try:
                item["content"] = json.loads(item["content"])
            except (json.JSONDecodeError, TypeError):
                pass
            scored.append((score, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for _, m in scored[:limit]]


# ── Orphan cleanup ──────────────────────────────────────────────────────


def delete_orphaned_blob() -> bool:
    """Delete the old JSON blob from memory_store if it exists.

    Returns True if the blob was found and deleted, False otherwise.
    Call this once after migration to avoid polluting LIKE-based searches.
    """
    blob = get_memory("auto_memories")
    if blob is not None:
        save_memory("auto_memories", None)  # Delete the key
        return True
    return False


# ── Background tasks ────────────────────────────────────────────────────


def extract_and_save_todos(messages: list[dict[str, Any]]) -> list[str]:
    """Extract todo items from assistant messages and save them."""
    todos = []
    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content", "")
        if isinstance(content, str):
            items = re.findall(r"- \[ \] (.+)", content)
            todos.extend(items)

    if todos:
        save_auto_memory("todos", todos, category="tasks", importance=0.8)

    return todos


def background_review(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Run a lightweight background review of the conversation."""
    if not messages:
        return {"reviewed": False, "reason": "no_messages"}

    # Count tool failures
    tool_errors = sum(
        1 for m in messages
        if m.get("role") == "tool" and "Error" in str(m.get("content", ""))
    )

    # Detect if user sounds frustrated
    user_msgs = [m for m in messages if m.get("role") == "user"]
    frustration_patterns = [
        r"\b(why|still|again|not working|fix this|wrong|incorrect)\b",
        r"\b(?!\w+@\w+)(frustrat|annoy|angry|disappoint)\b",
    ]
    frustrated = False
    for msg in user_msgs:
        text = str(msg.get("content", "")).lower()
        for pattern in frustration_patterns:
            if re.search(pattern, text):
                frustrated = True
                break

    result = {
        "reviewed": True,
        "tool_errors": tool_errors,
        "frustration_detected": frustrated,
        "message_count": len(messages),
        "needs_attention": tool_errors > 2 or frustrated,
    }

    # Save notable reviews
    if result["needs_attention"]:
        save_auto_memory(
            f"review_{time.time()}",
            result,
            category="review",
            importance=0.9,
        )

    return result
