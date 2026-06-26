"""
Auto-memory — automatically saves and retrieves relevant memory context.

Port of backend/services/memory/auto-memory.js + background-review.js.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.services.memory_store import save_memory, get_memory, search_memory

_KEY_MEMORIES = "auto_memories"
_MAX_MEMORIES = 100


def save_auto_memory(key: str, content: Any, category: str = "auto", importance: float = 0.5) -> None:
    """Save an automatically captured memory."""
    memories = get_memory(_KEY_MEMORIES) or []
    if not isinstance(memories, list):
        memories = []

    # Avoid exact duplicates
    for m in memories:
        if m.get("key") == key:
            m["content"] = content
            m["updated_at"] = __import__("datetime").datetime.utcnow().isoformat() + "Z"
            m["importance"] = importance
            save_memory(_KEY_MEMORIES, memories)
            return

    memories.append({
        "key": key,
        "content": content,
        "category": category,
        "importance": importance,
        "created_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    })

    # Trim oldest
    memories.sort(key=lambda m: m.get("importance", 0), reverse=True)
    memories = memories[:_MAX_MEMORIES]
    save_memory(_KEY_MEMORIES, memories)


def get_relevant_memories(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Find memories relevant to a query."""
    all_memories = get_memory(_KEY_MEMORIES) or []
    if not isinstance(all_memories, list):
        return []

    scored = []
    q = query.lower()
    for m in all_memories:
        score = 0.0
        key = str(m.get("key", "")).lower()
        content = str(m.get("content", "")).lower()
        if q in key:
            score += 0.5
        if q in content:
            score += 0.3
        score += m.get("importance", 0) * 0.2
        if score > 0:
            scored.append((score, m))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for _, m in scored[:limit]]


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
            f"review_{__import__('time').time()}",
            result,
            category="review",
            importance=0.9,
        )

    return result
