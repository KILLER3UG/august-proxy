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
from datetime import datetime, timezone
from app.services.memory_store import save_memory, get_memory

_MAXMemories = 100


def _conn():
    """Get the thread-local brain DB connection."""
    from app.services.memory_store import _conn as getConn

    return getConn()


def saveAutoMemory(key: str, content: object, category: str = 'auto', importance: float = 0.5) -> None:
    """Save an automatically captured memory as an individual FTS-indexed row.

    The FTS5 triggers on `auto_memories` (created in Phase 0) automatically
    keep `auto_memories_fts` in sync — no manual FTS insert needed.
    """
    conn = _conn()
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    contentJson = content if isinstance(content, str) else json.dumps(content)
    existing = conn.execute('SELECT id FROM auto_memories WHERE key = ?', (key,)).fetchone()
    if existing:
        conn.execute(
            'UPDATE auto_memories SET content = ?, importance = ?, updated_at = ? WHERE id = ?',
            (contentJson, importance, now, existing['id']),
        )
    else:
        conn.execute(
            'INSERT INTO auto_memories (key, content, category, importance, created_at) VALUES (?, ?, ?, ?, ?)',
            (key, contentJson, category, importance, now),
        )
    conn.execute(
        '\n        DELETE FROM auto_memories WHERE id NOT IN (\n            SELECT id FROM auto_memories ORDER BY importance DESC, id DESC LIMIT ?\n        )\n    ',
        (_MAXMemories,),
    )
    conn.commit()
    # Surface auto-memory writes in the Backend Monitor.
    try:
        from app.services import logger as _tl

        _tl.emitLogEvent(
            {
                'category': 'auto_memory',
                'level': 'info',
                'message': f'Auto-memory saved: {key}',
                'metadata': {'key': key, 'category': category, 'importance': importance},
            }
        )
    except Exception:
        pass


def getRelevantMemories(query: str, limit: int = 5) -> list[dict[str, object]]:
    """Find memories relevant to a query using FTS5 ranking.

    Falls back to LIKE-based search if FTS returns nothing.
    Returned keys keep camelCase ``createdAt`` for wire/API consumers.
    """
    conn = _conn()
    try:
        rows = conn.execute(
            'SELECT key, content, category, importance, created_at FROM auto_memories_fts WHERE content MATCH ? ORDER BY rank LIMIT ?',
            (query, limit),
        ).fetchall()
        if rows:
            from app.services.memory_store import _row_as_wire

            result = []
            for r in rows:
                item = _row_as_wire(r)
                try:
                    item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
                except (json.JSONDecodeError, TypeError):
                    pass
                result.append(item)
            return result
    except Exception:
        pass
    from app.services.memory_store import _row_as_wire

    allRows = conn.execute(
        'SELECT key, content, category, importance, created_at FROM auto_memories'
    ).fetchall()
    scored = []
    q = query.lower()
    for r in allRows:
        score = 0.0
        key = str(r['key'] or '').lower()
        content = str(r['content'] or '').lower()
        if q and q in key:
            score += 0.5
        if q and q in content:
            score += 0.3
        score += r['importance'] * 0.2
        if score > 0:
            item = _row_as_wire(r)
            try:
                item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
            except (json.JSONDecodeError, TypeError):
                pass
            scored.append((score, item))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for __, m in scored[:limit]]


def deleteOrphanedBlob() -> bool:
    """Delete the old JSON blob from memory_store if it exists.

    Returns True if the blob was found and deleted, False otherwise.
    Call this once after migration to avoid polluting LIKE-based searches.
    """
    # Blob key name stays camelCase (row key, not a table/column).
    blob = get_memory('autoMemories')
    if blob is not None:
        save_memory('autoMemories', None)
        return True
    return False


def extractAndSaveTodos(messages: list[dict[str, object]]) -> list[str]:
    """Extract todo items from assistant messages and save them."""
    todos = []
    for msg in messages:
        if msg.get('role') != 'assistant':
            continue
        content = msg.get('content', '')
        if isinstance(content, str):
            items = re.findall('- \\[ \\] (.+)', content)
            todos.extend(items)
    if todos:
        saveAutoMemory('todos', todos, category='tasks', importance=0.8)
    return todos


def backgroundReview(messages: list[dict[str, object]]) -> dict[str, object]:
    """Run a lightweight background review of the conversation."""
    if not messages:
        return {'reviewed': False, 'reason': 'no_messages'}
    toolErrors = sum((1 for m in messages if m.get('role') == 'tool' and 'Error' in str(m.get('content', ''))))
    userMsgs = [m for m in messages if m.get('role') == 'user']
    frustrationPatterns = [
        '\\b(why|still|again|not working|fix this|wrong|incorrect)\\b',
        '\\b(?!\\w+@\\w+)(frustrat|annoy|angry|disappoint)\\b',
    ]
    frustrated = False
    for msg in userMsgs:
        text = str(msg.get('content', '')).lower()
        for pattern in frustrationPatterns:
            if re.search(pattern, text):
                frustrated = True
                break
    result: dict[str, object] = {
        'reviewed': True,
        'tool_errors': toolErrors,
        'frustration_detected': frustrated,
        'message_count': len(messages),
        'needs_attention': toolErrors > 2 or frustrated,
    }
    if result['needs_attention']:
        saveAutoMemory(f'review_{time.time()}', result, category='review', importance=0.9)
    return result
