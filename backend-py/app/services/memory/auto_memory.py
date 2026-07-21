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
    # Surface auto-memory writes in the Backend Monitor + Feature Flow.
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
    try:
        from app.services.feature_flow import emit_feature_flow

        preview = contentJson if isinstance(contentJson, str) else str(contentJson)
        emit_feature_flow(
            feature='memory',
            stage='write',
            summary=f'Remembered: {key}',
            status='ok',
            meta={
                'key': key,
                'category': category,
                'importance': importance,
                'preview': preview[:160],
            },
        )
    except Exception:
        pass
    # Wire vector + graph planes when feature flags are on (product honesty).
    try:
        from app.services.cognitive_config import get_features

        features = get_features()
        preview = contentJson if isinstance(contentJson, str) else str(contentJson)
        text = f'{key}: {preview}'[:4000]
        if features.get('vector_memory', True):
            try:
                from app.services.memory import vector_db

                vector_db.insert(
                    text,
                    metadata={'key': key, 'category': category, 'source': 'auto_memory'},
                    namespace='auto_memory',
                )
            except Exception:
                pass
        if features.get('graph_memory', True):
            try:
                from app.services.memory import graph_memory

                preview_text = (preview if isinstance(preview, str) else str(preview))[:400]
                label = graph_memory.humanize_entity_label(
                    key,
                    {'preview': preview_text, 'importance': importance},
                )
                graph_memory.addEntity(
                    key,
                    entityType=category or 'memory',
                    metadata={
                        'importance': importance,
                        'label': label,
                        'preview': preview_text[:240],
                    },
                )
                # Link category → key when category is meaningful
                if category and category not in ('auto', 'general', ''):
                    graph_memory.addEntity(
                        category,
                        entityType='category',
                        metadata={'label': graph_memory.humanize_entity_label(category)},
                    )
                    graph_memory.addRelation(category, key, 'contains')
            except Exception:
                pass
    except Exception:
        pass


def enrich_memory_for_model(item: dict[str, object]) -> dict[str, object]:
    """Add beginner-readable ``label`` / ``description`` for prompts and tools.

    Keeps the raw ``key`` so the model can pass it back to tools if needed.
    """
    if not isinstance(item, dict):
        return item
    key = str(item.get('key') or '')
    content = item.get('content', '')
    if isinstance(content, (dict, list)):
        preview = json.dumps(content, default=str, ensure_ascii=False)
    else:
        preview = str(content or '')
    meta = {'preview': preview[:400]}
    try:
        from app.services.memory import graph_memory

        item['label'] = graph_memory.humanize_entity_label(key, meta)
        item['description'] = graph_memory.entity_description(key, meta) or preview[:240]
        item['categoryLabel'] = graph_memory.humanize_entity_type(
            str(item.get('category') or 'memory')
        )
    except Exception:
        item.setdefault('label', key.replace('_', ' ') if key else 'Memory')
        item.setdefault('description', preview[:240])
    return item


def getRelevantMemories(query: str, limit: int = 5) -> list[dict[str, object]]:
    """Find memories relevant to a query using FTS5 ranking.

    FTS virtual table only has ``key``/``content``; metadata comes from a
    JOIN to ``auto_memories``. Falls back to a **bounded** LIKE scan if FTS
    returns nothing (never loads the whole table unbounded).
    Returned keys keep camelCase ``createdAt`` for wire/API consumers.
    Each hit also includes ``label`` / ``description`` for model-facing use.
    """
    conn = _conn()
    lim = max(1, min(int(limit), 50))
    from app.services.memory_store import _row_as_wire, _fts_match_query

    try:
        ftsQ = _fts_match_query(query) if query and query.strip() else ''
        if ftsQ:
            # Table-level MATCH must name the FTS table (alias MATCH can fail as
            # "no such column" on some SQLite builds).
            rows = conn.execute(
                'SELECT t.key, t.content, t.category, t.importance, t.created_at '
                'FROM auto_memories_fts AS fts '
                'JOIN auto_memories AS t ON fts.rowid = t.rowid '
                'WHERE auto_memories_fts MATCH ? ORDER BY rank LIMIT ?',
                (ftsQ, lim),
            ).fetchall()
            if rows:
                result = []
                for r in rows:
                    item = _row_as_wire(r)
                    try:
                        item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
                    except (json.JSONDecodeError, TypeError):
                        pass
                    result.append(enrich_memory_for_model(item))
                return result
    except Exception:
        pass

    # Bounded fallback — never SELECT entire auto_memories without LIMIT.
    like = f'%{(query or "").strip()}%'
    if like == '%%':
        return []
    allRows = conn.execute(
        'SELECT key, content, category, importance, created_at FROM auto_memories '
        'WHERE key LIKE ? OR content LIKE ? '
        'ORDER BY importance DESC LIMIT ?',
        (like, like, max(lim * 4, 20)),
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
            scored.append((score, enrich_memory_for_model(item)))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for __, m in scored[:limit]]


def list_all_auto_memories(category: str = '') -> list[dict[str, object]]:
    """List every ``auto_memories`` row (with id), optionally filtered by category.

    Ordered by category then most-recently-updated so the settings panel can
    group rows by category without a separate query per group.
    """
    conn = _conn()
    from app.services.memory_store import _row_as_wire

    if category:
        rows = conn.execute(
            'SELECT id, key, content, category, importance, source, created_at, updated_at '
            'FROM auto_memories WHERE category = ? ORDER BY updated_at DESC, id DESC',
            (category,),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT id, key, content, category, importance, source, created_at, updated_at '
            'FROM auto_memories ORDER BY category ASC, updated_at DESC, id DESC'
        ).fetchall()
    result = []
    for r in rows:
        item = _row_as_wire(r)
        try:
            item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
        except (json.JSONDecodeError, TypeError):
            pass
        result.append(item)
    return result


def get_auto_memory(memory_id: int) -> dict[str, object] | None:
    """Fetch a single ``auto_memories`` row by id."""
    conn = _conn()
    from app.services.memory_store import _row_as_wire

    row = conn.execute(
        'SELECT id, key, content, category, importance, source, created_at, updated_at '
        'FROM auto_memories WHERE id = ?',
        (memory_id,),
    ).fetchone()
    if not row:
        return None
    item = _row_as_wire(row)
    try:
        item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
    except (json.JSONDecodeError, TypeError):
        pass
    return item


def create_auto_memory(
    key: str, content: object, category: str = 'auto', importance: float = 0.5
) -> int | None:
    """Create (or upsert-by-key) a memory row via ``saveAutoMemory`` and return its id."""
    saveAutoMemory(key, content, category=category, importance=importance)
    conn = _conn()
    row = conn.execute('SELECT id FROM auto_memories WHERE key = ?', (key,)).fetchone()
    return int(row['id']) if row else None


def update_auto_memory(
    memory_id: int,
    content: object = None,
    category: str | None = None,
    importance: float | None = None,
) -> bool:
    """Update fields on an existing ``auto_memories`` row by id. No-op fields stay untouched."""
    conn = _conn()
    existing = conn.execute('SELECT id FROM auto_memories WHERE id = ?', (memory_id,)).fetchone()
    if not existing:
        return False
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    sets: list[str] = []
    params: list[object] = []
    if content is not None:
        sets.append('content = ?')
        params.append(content if isinstance(content, str) else json.dumps(content))
    if category is not None:
        sets.append('category = ?')
        params.append(category)
    if importance is not None:
        sets.append('importance = ?')
        params.append(importance)
    if not sets:
        return True
    sets.append('updated_at = ?')
    params.append(now)
    params.append(memory_id)
    conn.execute(f'UPDATE auto_memories SET {", ".join(sets)} WHERE id = ?', params)
    conn.commit()
    return True


def delete_auto_memory(memory_id: int) -> bool:
    """Delete an ``auto_memories`` row by id."""
    conn = _conn()
    existing = conn.execute('SELECT id FROM auto_memories WHERE id = ?', (memory_id,)).fetchone()
    if not existing:
        return False
    conn.execute('DELETE FROM auto_memories WHERE id = ?', (memory_id,))
    conn.commit()
    return True


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
