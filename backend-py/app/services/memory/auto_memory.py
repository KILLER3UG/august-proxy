"""
Auto-memory — automatically saves and retrieves relevant memory context.

Phase 0 rewrite: writes individual FTS-indexed rows to the `auto_memories`
table instead of a JSON blob under one key in `memory_store`.

``source`` distinguishes:
  - ``auto`` / ``agent`` / empty — Recalled Memory (on-demand tools)
  - ``user`` — Added Memory (injected every turn)
"""

from __future__ import annotations
import json
import re
import time
from datetime import datetime, timezone
from app.services.memory_store import save_memory, get_memory

_MAXMemories = 100
_AREAS_CATEGORIES = frozenset({'correction', 'learning', 'preference', 'user'})
_TELEMETRY_KEY_PREFIXES = ('tool_failure_',)


def _conn():
    """Get the thread-local brain DB connection."""
    from app.services.memory_store import _conn as getConn

    return getConn()


def _normalize_source(source: str | None) -> str:
    s = (source or '').strip().lower()
    if s == 'user':
        return 'user'
    if s in ('auto', 'agent'):
        return s
    return 'auto'


def _is_user_source(source: object) -> bool:
    return str(source or '').strip().lower() == 'user'


def _is_telemetry_key(key: str) -> bool:
    return any(key.startswith(p) for p in _TELEMETRY_KEY_PREFIXES)


def _content_preview(content: object) -> str:
    if isinstance(content, (dict, list)):
        return json.dumps(content, default=str, ensure_ascii=False)
    return str(content or '')


def _enforce_cap(conn) -> None:
    """Keep at most ``_MAXMemories`` rows, preferring to drop low-importance auto rows first."""
    total = conn.execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c']
    if int(total) <= _MAXMemories:
        return
    overflow = int(total) - _MAXMemories
    conn.execute(
        """
        DELETE FROM auto_memories WHERE id IN (
            SELECT id FROM auto_memories
            WHERE COALESCE(source, '') != 'user'
            ORDER BY importance ASC, id ASC
            LIMIT ?
        )
        """,
        (overflow,),
    )
    total = conn.execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c']
    if int(total) <= _MAXMemories:
        return
    overflow = int(total) - _MAXMemories
    conn.execute(
        """
        DELETE FROM auto_memories WHERE id IN (
            SELECT id FROM auto_memories
            ORDER BY
              CASE WHEN COALESCE(source, '') = 'user' THEN 1 ELSE 0 END ASC,
              importance ASC,
              id ASC
            LIMIT ?
        )
        """,
        (overflow,),
    )


def saveAutoMemory(
    key: str,
    content: object,
    category: str = 'auto',
    importance: float = 0.5,
    source: str = 'auto',
) -> None:
    """Save an automatically captured memory as an individual FTS-indexed row."""
    conn = _conn()
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    contentJson = content if isinstance(content, str) else json.dumps(content)
    src = _normalize_source(source)
    existing = conn.execute('SELECT id, source FROM auto_memories WHERE key = ?', (key,)).fetchone()
    if existing:
        keep_src = 'user' if _is_user_source(existing['source']) and src != 'user' else src
        conn.execute(
            'UPDATE auto_memories SET content = ?, importance = ?, category = ?, '
            'source = ?, updated_at = ? WHERE id = ?',
            (contentJson, importance, category, keep_src, now, existing['id']),
        )
    else:
        conn.execute(
            'INSERT INTO auto_memories (key, content, category, importance, source, created_at, updated_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (key, contentJson, category, importance, src, now, now),
        )
    _enforce_cap(conn)
    conn.commit()
    try:
        from app.services import logger as _tl

        _tl.emitLogEvent(
            {
                'category': 'auto_memory',
                'level': 'info',
                'message': f'Auto-memory saved: {key}',
                'metadata': {
                    'key': key,
                    'category': category,
                    'importance': importance,
                    'source': src,
                },
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
                'source': src,
                'preview': preview[:160],
            },
        )
    except Exception:
        pass
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
                    metadata={'key': key, 'category': category, 'source': src},
                    namespace='auto_memory',
                )
            except Exception:
                pass
        if features.get('graph_memory', True):
            try:
                from app.services.memory import graph_memory

                preview_text = (preview if isinstance(preview, str) else str(preview))[:400]
                ui = present_memory_fields(key, content, category)
                label = str(ui.get('title') or graph_memory.humanize_entity_label(
                    key, {'preview': preview_text, 'importance': importance}
                ))[:48]
                graph_memory.addEntity(
                    key,
                    entityType=category or 'memory',
                    metadata={
                        'importance': importance,
                        'label': label,
                        'preview': str(ui.get('summary') or preview_text)[:240],
                        'source': src,
                    },
                )
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


def present_memory_fields(
    key: str, content: object, category: str = 'auto'
) -> dict[str, object]:
    """Build title / summary / details / section for UI and prompts (never raw JSON labels)."""
    cat = (category or 'auto').strip() or 'auto'
    section = 'areas' if cat in _AREAS_CATEGORIES else 'topics'
    preview = _content_preview(content).strip()

    if isinstance(content, dict):
        if 'suggestion' in content and 'count' in content:
            count = content.get('count')
            suggestion = str(content.get('suggestion') or 'Review tool usage patterns')
            preview = f'High tool failure rate ({count} errors). {suggestion}'
        elif 'fact' in content:
            preview = str(content.get('fact') or preview)
        else:
            parts = [f'{k}: {v}' for k, v in content.items() if not str(k).startswith('_')]
            preview = '; '.join(str(p) for p in parts)[:400] if parts else preview

    if isinstance(content, list):
        preview = '; '.join(str(x) for x in content)[:400]

    title = ''
    if key.startswith('conv_summary_'):
        m = re.search(r'User asked:\s*(.+?)(?:\s*\(session|\s*$)', preview, re.I | re.S)
        asked = (m.group(1).strip() if m else '')[:80]
        title = f'Chat: {asked}' if asked else 'Chat summary'
    elif key.startswith('correction_'):
        title = 'Correction'
        if preview.lower().startswith('user prefers:'):
            title = f"Correction: {preview.split(':', 1)[-1].strip()[:60]}"
    elif key.startswith('tool_failure_'):
        title = 'Tool usage'
    elif key.startswith('quick_') or key.startswith('added_'):
        title = preview.split('\n', 1)[0][:60] or 'Added memory'
    elif key == 'todos':
        title = 'Todos'
    else:
        words = [w for w in re.split(r'[_\-]+', key) if w]
        if words and words[0].lower() in ('ent', 'mem', 'kv'):
            words = words[1:] or words
        title = ' '.join(w.capitalize() for w in words)[:60] or 'Memory'

    if title.lstrip().startswith('{'):
        title = 'Memory'

    summary = preview.split('\n', 1)[0].strip()[:160]
    if summary.lstrip().startswith('{'):
        summary = title

    details: list[str] = []
    if isinstance(content, list):
        details = [str(x).strip() for x in content if str(x).strip()]
    elif isinstance(content, str) and '\n' in content:
        details = [ln.strip().lstrip('-•* ').strip() for ln in content.splitlines() if ln.strip()]
    elif preview:
        details = [preview[:500]]

    try:
        from app.services.memory import graph_memory

        category_label = graph_memory.humanize_entity_type(cat)
    except Exception:
        category_label = cat.replace('_', ' ').title()

    return {
        'title': title,
        'summary': summary,
        'details': details[:40],
        'section': section,
        'categoryLabel': category_label,
    }


def enrich_memory_for_model(item: dict[str, object]) -> dict[str, object]:
    """Add beginner-readable label / description / title fields for prompts and tools."""
    if not isinstance(item, dict):
        return item
    key = str(item.get('key') or '')
    content = item.get('content', '')
    category = str(item.get('category') or 'auto')
    presented = present_memory_fields(key, content, category)
    item['title'] = presented['title']
    item['summary'] = presented['summary']
    item['details'] = presented['details']
    item['section'] = presented['section']
    item['label'] = presented['title']
    item['description'] = presented['summary']
    item['categoryLabel'] = presented['categoryLabel']
    src = _normalize_source(str(item.get('source') or ''))
    if not item.get('source'):
        item['source'] = src
    item['origin'] = 'added' if src == 'user' else 'recalled'
    return item


def getRelevantMemories(query: str, limit: int = 5) -> list[dict[str, object]]:
    """Find memories relevant to a query using FTS5 ranking."""
    conn = _conn()
    lim = max(1, min(int(limit), 50))
    from app.services.memory_store import _row_as_wire, _fts_match_query

    cols = 't.id, t.key, t.content, t.category, t.importance, t.source, t.created_at, t.updated_at'
    try:
        ftsQ = _fts_match_query(query) if query and query.strip() else ''
        if ftsQ:
            rows = conn.execute(
                f'SELECT {cols} '
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

    like = f'%{(query or "").strip()}%'
    if like == '%%':
        return []
    allRows = conn.execute(
        'SELECT id, key, content, category, importance, source, created_at, updated_at '
        'FROM auto_memories WHERE key LIKE ? OR content LIKE ? '
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
        score += float(r['importance'] or 0) * 0.2
        if _is_user_source(r['source']):
            score += 0.15
        if score > 0:
            item = _row_as_wire(r)
            try:
                item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
            except (json.JSONDecodeError, TypeError):
                pass
            scored.append((score, enrich_memory_for_model(item)))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for __, m in scored[:limit]]


def list_user_added_memories(limit: int = 50) -> list[dict[str, object]]:
    """Return user-authored memories for every-turn prompt injection."""
    conn = _conn()
    from app.services.memory_store import _row_as_wire

    lim = max(1, min(int(limit), 100))
    rows = conn.execute(
        'SELECT id, key, content, category, importance, source, created_at, updated_at '
        "FROM auto_memories WHERE source = 'user' "
        'ORDER BY importance DESC, updated_at DESC LIMIT ?',
        (lim,),
    ).fetchall()
    out = []
    for r in rows:
        item = _row_as_wire(r)
        try:
            item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
        except (json.JSONDecodeError, TypeError):
            pass
        out.append(enrich_memory_for_model(item))
    return out


def list_all_auto_memories(
    category: str = '',
    origin: str = 'all',
    include_telemetry: bool = True,
) -> list[dict[str, object]]:
    """List ``auto_memories`` rows with optional origin / telemetry filters.

    ``origin``: ``all`` | ``recalled`` | ``added``
    """
    conn = _conn()
    from app.services.memory_store import _row_as_wire

    origin_n = (origin or 'all').strip().lower()
    clauses: list[str] = []
    params: list[object] = []
    if category:
        clauses.append('category = ?')
        params.append(category)
    if origin_n == 'added':
        clauses.append("source = 'user'")
    elif origin_n == 'recalled':
        clauses.append("COALESCE(source, '') != 'user'")
    where = f'WHERE {" AND ".join(clauses)}' if clauses else ''
    rows = conn.execute(
        f'SELECT id, key, content, category, importance, source, created_at, updated_at '
        f'FROM auto_memories {where} ORDER BY category ASC, updated_at DESC, id DESC',
        params,
    ).fetchall()
    result = []
    for r in rows:
        key = str(r['key'] or '')
        if not include_telemetry and _is_telemetry_key(key):
            continue
        item = _row_as_wire(r)
        try:
            item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
        except (json.JSONDecodeError, TypeError):
            pass
        result.append(enrich_memory_for_model(item))
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
    return enrich_memory_for_model(item)


def create_auto_memory(
    key: str,
    content: object,
    category: str = 'auto',
    importance: float = 0.5,
    source: str = 'auto',
) -> int | None:
    """Create (or upsert-by-key) a memory row and return its id."""
    saveAutoMemory(key, content, category=category, importance=importance, source=source)
    conn = _conn()
    row = conn.execute('SELECT id FROM auto_memories WHERE key = ?', (key,)).fetchone()
    return int(row['id']) if row else None


def update_auto_memory(
    memory_id: int,
    content: object = None,
    category: str | None = None,
    importance: float | None = None,
    source: str | None = None,
) -> bool:
    """Update fields on an existing ``auto_memories`` row by id."""
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
    if source is not None:
        sets.append('source = ?')
        params.append(_normalize_source(source))
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
    """Delete the old JSON blob from memory_store if it exists."""
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
        saveAutoMemory('todos', todos, category='tasks', importance=0.8, source='auto')
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
        saveAutoMemory(
            f'review_{time.time()}', result, category='review', importance=0.9, source='auto'
        )
    return result
