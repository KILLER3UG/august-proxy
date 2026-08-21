"""
Auto-memory — automatically saves and retrieves relevant memory context.

Phase 0 rewrite: writes individual FTS-indexed rows to the `auto_memories`
table instead of a JSON blob under one key in `memory_store`.

``source`` distinguishes:
  - ``auto`` / ``agent`` / empty — Recalled Memory (on-demand tools)
  - ``user`` — Added Memory (injected every turn)
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
from datetime import datetime, timezone

from app.json_narrowing import as_dict, as_int, as_str
from app.services.memory_store import get_memory, save_memory

logger = logging.getLogger(__name__)

_MAXMemories = 100
_AREAS_CATEGORIES = frozenset({'correction', 'learning', 'preference', 'user'})
_TELEMETRY_KEY_PREFIXES = ('tool_failure_',)
_ROW_COLS = 'id, key, content, category, importance, source, pinned, created_at, updated_at, source_session_id, expires_at, confidence, ttl_days'
_NEAR_DUP_THRESHOLD = 0.85
_NEAR_DUP_IMPORTANCE_STEP = 0.1
_EPISODE_MERGE_MIN = 8
_EPISODE_MERGE_COUNT = 5

_TTL_BY_CATEGORY: dict[str, int | None] = {
    'conversation': 7,
    'telemetry': 7,
    'learning': 7,
    'preference': 60,
    'general': 60,
    'auto': 60,
    'fact': 90,
    'tasks': 30,
    'correction': 30,
}
_GENERIC_PREF_RE = re.compile(r'user\s+prefers\s*:\s*(you|think)\b', re.I)
_DEFAULT_CONFIDENCE = 0.7
_LOW_CONFIDENCE = 0.3


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


def _parse_ts(value: object) -> datetime | None:
    """Parse a stored timestamp — ISO 'Z' form or SQLite 'YYYY-MM-DD HH:MM:SS'."""
    s = str(value or '').strip()
    if not s:
        return None
    if s.endswith('Z'):
        s = s[:-1] + '+00:00'
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        pass
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M:%S.%f'):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _decay_factor(ts_value: object, half_life_days: float = 30.0) -> float:
    """Recency decay in [0, 1] — 0.5 at ``half_life_days``, near 0 past ~5 half-lives."""
    ts = _parse_ts(ts_value)
    if ts is None:
        return 1.0
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    age_days = max(0.0, (datetime.now(timezone.utc) - ts).total_seconds() / 86400.0)
    return 0.5 ** (age_days / half_life_days)


def _derive_ttl_days(category: str, pinned: int) -> int | None:
    if pinned:
        return None
    return _TTL_BY_CATEGORY.get((category or 'auto').strip().lower(), 60)


def _derive_confidence(content: object, category: str, pinned: int) -> float:
    if pinned:
        return 0.9
    text = str(content or '')
    if _GENERIC_PREF_RE.search(text):
        return _LOW_CONFIDENCE
    cat = (category or '').strip().lower()
    if cat in ('conversation', 'telemetry'):
        return 0.45
    return _DEFAULT_CONFIDENCE


def _compute_expires_at(ttl_days: int | None) -> str | None:
    if ttl_days is None:
        return None
    from datetime import timedelta

    return (datetime.now(timezone.utc) + timedelta(days=ttl_days)).isoformat().replace('+00:00', 'Z')


def prune_expired_memories(limit: int = 50) -> int:
    conn = _conn()
    try:
        rows = conn.execute(
            "SELECT id FROM auto_memories WHERE expires_at IS NOT NULL AND expires_at < datetime('now') AND COALESCE(pinned, 0) = 0 LIMIT ?",
            (max(1, limit),),
        ).fetchall()
        ids = [int(r['id']) for r in rows]
        if not ids:
            return 0
        placeholders = ','.join('?' for _ in ids)
        conn.execute(f'DELETE FROM auto_memories WHERE id IN ({placeholders})', ids)
        conn.commit()
        return len(ids)
    except Exception:
        return 0


def _is_expired_row(row: object) -> bool:
    try:
        exp = row['expires_at'] if isinstance(row, dict) else row['expires_at']  # type: ignore[index]
    except Exception:
        return False
    if not exp:
        return False
    ts = _parse_ts(exp)
    if ts is None:
        return False
    now = datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts < now


def _normalize_text(text: object) -> str:
    """Lowercase and collapse punctuation/whitespace — basis for near-dup checks."""
    return ' '.join(re.sub(r'[^a-z0-9]+', ' ', str(text or '').lower()).split())


def _similarity(a: object, b: object) -> float:
    """Token-overlap similarity in [0, 1]; 1.0 when one text covers the other.

    Short inputs (fewer than 3 tokens) score 0 so a single common token
    (e.g. "python") cannot absorb an unrelated longer memory.
    """
    from app.services.memory.user_profile import _similarity as _shared_similarity

    return _shared_similarity(a, b)


def _find_near_dup(conn, content: object, exclude_key: str = '') -> sqlite3.Row | None:
    """Return the best-matching existing row when ``content`` near-duplicates it.

    Update-over-duplicate: refreshing the existing memory (recency + importance)
    is preferred over inserting a twin. Scans the FULL table — a top-N recency
    window meant a memory that fell out of the window got a twin instead of a
    refresh, and dedup degraded exactly as the store filled (audit finding;
    the store is capped at ~100 rows, so a full scan is cheap).
    """
    rows = conn.execute(
        f'SELECT {_ROW_COLS} FROM auto_memories ORDER BY updated_at DESC'
    ).fetchall()
    best, best_score = None, 0.0
    for r in rows:
        if r['key'] == exclude_key:
            continue
        score = _similarity(content, r['content'])
        if score > best_score:
            best, best_score = r, score
    return best if best_score >= _NEAR_DUP_THRESHOLD else None


def _content_preview(content: object) -> str:
    if isinstance(content, (dict, list)):
        return json.dumps(content, default=str, ensure_ascii=False)
    return str(content or '')


def _clamp_importance(value: object, default: float = 0.5) -> float:
    """Parse an importance value into [0, 1], falling back to ``default``."""
    try:
        v = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, v))


def _evict_rows(conn, count: int, protect_user: bool) -> list[int]:
    """Delete the ``count`` lowest-scoring rows (importance × recency decay).

    The read-score-delete sequence runs inside ``BEGIN IMMEDIATE`` so
    concurrent threads (per-session worker threads) cannot interleave and
    evict rows another thread just refreshed.
    """
    if count <= 0:
        return []
    # Pinned memories are protected in BOTH passes — the second (non-user-
    # protected) pass previously used an empty WHERE and could silently
    # delete user-added and explicitly pinned memories (audit finding).
    pinned_clause = 'COALESCE(pinned, 0) = 0'
    user_clause = "COALESCE(source, '') != 'user'"
    where = f'WHERE {pinned_clause} AND {user_clause}' if protect_user else f'WHERE {pinned_clause}'
    conn.execute('BEGIN IMMEDIATE')
    try:
        rows = conn.execute(f'SELECT id, importance, updated_at FROM auto_memories {where}').fetchall()
        scored = []
        for r in rows:
            imp = r['importance']
            importance = 0.5 if imp is None else float(imp)
            scored.append((importance * _decay_factor(r['updated_at']), int(r['id'])))
        scored.sort(key=lambda x: (x[0], x[1]))
        ids = [i for _, i in scored[:count]]
        if ids:
            placeholders = ','.join('?' for _ in ids)
            conn.execute(f'DELETE FROM auto_memories WHERE id IN ({placeholders})', ids)
        conn.commit()
    except Exception:
        conn.execute('ROLLBACK')
        raise
    return ids


def _enforce_cap(conn) -> None:
    """Keep at most ``_MAXMemories`` rows, consolidating before evicting.

    Conversation summaries are merged into episodes first; only the remaining
    overflow is pruned (low-importance stale rows, user/pinned protected).
    Pruning is surfaced as a brain event plus an episodic-timeline entry so
    memory loss is never silent.
    """
    total = conn.execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c']
    if int(total) <= _MAXMemories:
        return
    # Consolidation-first: merging old conversation summaries frees rows.
    try:
        consolidate_conv_summaries()
    except Exception:
        pass
    total = conn.execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c']
    if int(total) <= _MAXMemories:
        return
    overflow = int(total) - _MAXMemories
    removed = _evict_rows(conn, overflow, protect_user=True)
    total = conn.execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c']
    if int(total) > _MAXMemories:
        removed += _evict_rows(conn, int(total) - _MAXMemories, protect_user=False)
    if removed:
        try:
            from app.services.brain_event_bus import emitBrainEvent

            emitBrainEvent(
                category='memory',
                layer='auto_memory.cap',
                summary=f'Memory cap active: pruned {len(removed)} low-value/stale memories',
                meta={'pruned': len(removed)},
            )
        except Exception:
            pass
        try:
            from app.services.memory_store.rest import write_timeline_event

            write_timeline_event(
                None,
                f'Memory cap active: pruned {len(removed)} low-value/stale memories',
                category='memory',
            )
        except Exception:
            pass


def saveAutoMemory(
    key: str,
    content: object,
    category: str = 'auto',
    importance: float = 0.5,
    source: str = 'auto',
    pinned: int | bool = 0,
    session_id: str = '',
) -> None:
    """Save an automatically captured memory as an individual FTS-indexed row.

    ``pinned`` memories are always-loaded context (like user-added memory)
    rather than on-demand recall. A near-duplicate insert refreshes the
    existing row (recency + importance) instead of creating a twin.
    ``session_id`` records which conversation produced the memory
    (provenance for the Brain "You"/Journey surfaces); best-effort.
    """
    conn = _conn()
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    contentJson = content if isinstance(content, str) else json.dumps(content)
    src = _normalize_source(source)
    pin = 1 if pinned else 0
    importance = _clamp_importance(importance)
    confidence = _derive_confidence(contentJson, category, pin)
    ttl_days = _derive_ttl_days(category, pin)
    expires_at = _compute_expires_at(ttl_days)
    # Backstop: secrets never enter long-lived memory from model/agent paths.
    # User-added memories (UI / API) are the user's own choice.
    if not _is_user_source(src):
        try:
            from app.services.memory.memory_scrubber import emit_scrub_event, find_secrets

            if find_secrets(contentJson):
                emit_scrub_event(layer='auto_memory')
                return
        except Exception:
            pass
    # BEGIN IMMEDIATE: the check-then-write below must be atomic — two
    # concurrent writers saving the same key both saw "no existing row" and
    # inserted twins (audit finding; the unique index is the backstop).
    conn.execute('BEGIN IMMEDIATE')
    try:
        existing = conn.execute('SELECT id, source FROM auto_memories WHERE key = ?', (key,)).fetchone()
        if existing:
            keep_src = 'user' if _is_user_source(existing['source']) and src != 'user' else src
            # OR-semantics on pinned: a write never unpins an explicitly pinned memory.
            conn.execute(
                'UPDATE auto_memories SET content = ?, importance = ?, category = ?, '
                'source = ?, pinned = MAX(COALESCE(pinned, 0), ?), updated_at = ?, '
                'source_session_id = COALESCE(?, source_session_id), '
                'expires_at = COALESCE(?, expires_at), confidence = ?, ttl_days = COALESCE(?, ttl_days) WHERE id = ?',
                (contentJson, importance, category, keep_src, pin, now, session_id or None, expires_at, confidence, ttl_days, existing['id']),
            )
        else:
            dup = _find_near_dup(conn, content, exclude_key=key)
            if dup is not None:
                # Update-over-duplicate carries the NEWEST text — previously
                # only recency/importance were bumped, so an amended or
                # contradicted fact kept the OLD (now wrong) content with
                # boosted importance (audit finding).
                conn.execute(
                    'UPDATE auto_memories SET content = ?, category = ?, '
                    'importance = MIN(1.0, importance + ?), '
                    'pinned = MAX(COALESCE(pinned, 0), ?), updated_at = ?, '
                    'source_session_id = COALESCE(?, source_session_id), '
                    'expires_at = COALESCE(?, expires_at), confidence = ?, ttl_days = COALESCE(?, ttl_days) WHERE id = ?',
                    (contentJson, category, _NEAR_DUP_IMPORTANCE_STEP, pin, now, session_id or None, expires_at, confidence, ttl_days, dup['id']),
                )
                conn.commit()
                _emit_memory_saved(key, category, importance, src, preview=contentJson[:160])
                return
            try:
                conn.execute(
                    'INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at, source_session_id, expires_at, confidence, ttl_days) '
                    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (key, contentJson, category, importance, src, pin, now, now, session_id or None, expires_at, confidence, ttl_days),
                )
            except sqlite3.IntegrityError:
                # A concurrent writer inserted the same key between our SELECT
                # and INSERT (unique index) — update that row instead.
                conn.execute(
                    'UPDATE auto_memories SET content = ?, importance = ?, category = ?, '
                    'source = ?, pinned = MAX(COALESCE(pinned, 0), ?), updated_at = ?, '
                    'source_session_id = COALESCE(?, source_session_id), '
                    'expires_at = COALESCE(?, expires_at), confidence = ?, ttl_days = COALESCE(?, ttl_days) WHERE key = ?',
                    (contentJson, importance, category, src, pin, now, session_id or None, expires_at, confidence, ttl_days, key),
                )
        # Commit before cap enforcement: _enforce_cap opens its own
        # BEGIN IMMEDIATE transactions (eviction + episode merge) and must not
        # find an uncommitted INSERT on this connection.
        conn.commit()
    except Exception:
        try:
            conn.execute('ROLLBACK')
        except sqlite3.OperationalError:
            pass
        raise
    _enforce_cap(conn)
    _emit_memory_saved(key, category, importance, src, preview=contentJson[:160])
    try:
        from app.services.cognitive_config import get_features

        features = get_features()
        preview = contentJson if isinstance(contentJson, str) else str(contentJson)
        text = f'{key}: {preview}'[:4000]
        if features.get('vector_memory', True):
            try:
                from app.services.memory import vector_db

                vector_db.upsert(
                    text,
                    metadata={'key': key, 'category': category, 'source': src, 'pinned': pin},
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
                        'pinned': pin,
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
    # Derived markdown mirror (best-effort, debounced, secrets already scrubbed)
    try:
        from app.services.memory.markdown_export import debounced_export_memory

        # Derive folder_id from session if available
        fid = ""
        if session_id:
            try:
                from app.services.workbench.sessions import get_workbench_session as _gws

                sess = _gws(session_id)
                if sess:
                    fid = str(getattr(sess, "folderId", "") or getattr(sess, "folder_id", "") or "")
                    # Also handle dict-style
                    if not fid and isinstance(sess, dict):
                        fid = str(sess.get("folderId") or sess.get("folder_id") or "")
            except Exception:
                pass
        debounced_export_memory(folder_id=fid, origin="all")
        if fid:
            debounced_export_memory(folder_id=fid, origin="recalled")
    except Exception:
        pass


def _emit_memory_saved(key: str, category: str, importance: float, source: str, preview: str = '') -> None:
    """Emit log + feature-flow entries for a memory write (shared by all paths)."""
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
                    'source': source,
                },
            }
        )
    except Exception:
        pass
    try:
        from app.services.feature_flow import emit_feature_flow

        emit_feature_flow(
            feature='memory',
            stage='write',
            summary=f'Remembered: {key}',
            status='ok',
            meta={
                'key': key,
                'category': category,
                'importance': importance,
                'source': source,
                'preview': preview,
            },
        )
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


def _is_durable_recall_memory(row: object) -> bool:
    """Return whether a row is useful for automatic prompt recall.

    Conversation summaries and low-signal telemetry are still searchable on
    demand, but they should not be pushed into every new prompt. Automatic
    recall is reserved for explicit/user-authored memories, pinned items, and
    high-importance durable facts.
    """
    if not isinstance(row, dict):
        try:
            key = str(row['key'] or '')  # type: ignore[index]
            category = str(row['category'] or '')  # type: ignore[index]
            source = str(row['source'] or '')  # type: ignore[index]
            pinned = bool(row['pinned'])  # type: ignore[index]
            importance = float(row['importance'] or 0.0)  # type: ignore[index]
        except (KeyError, TypeError, ValueError):
            return False
    else:
        key = str(row.get('key') or '')
        category = str(row.get('category') or '')
        source = str(row.get('source') or '')
        pinned = bool(row.get('pinned'))
        try:
            importance = float(row.get('importance') or 0.0)
        except (TypeError, ValueError):
            importance = 0.0

    if category.strip().lower() in {'conversation', 'telemetry', 'learning'}:
        return False
    if key.startswith(('conv_summary_', 'episode_', 'tool_failure_')):
        return False
    return _is_user_source(source) or pinned or importance >= 0.65


def getRelevantMemories(
    query: str,
    limit: int = 5,
    *,
    durable_only: bool = False,
) -> list[dict[str, object]]:
    """Find memories relevant to a query using FTS5 ranking + recency decay.

    FTS rank supplies the relevance half of the score; ``_decay_factor`` on
    ``updated_at`` supplies the recency half, so fresh memories win ties and
    stale entries fall out of the top-k unless strongly relevant. When
    ``durable_only`` is true, low-value conversation summaries and telemetry
    are omitted for automatic prompt recall while remaining available to the
    explicit memory-search tool.
    """
    conn = _conn()
    try:
        prune_expired_memories(limit=50)
    except Exception:
        pass
    lim = max(1, min(int(limit), 50))
    from app.services.memory_store import _fts_match_query, _row_as_wire

    cols = 't.id, t.key, t.content, t.category, t.importance, t.source, t.pinned, t.created_at, t.updated_at, t.expires_at, t.confidence, t.ttl_days'
    min_conf = 0.65 if durable_only else 0.45
    try:
        ftsQ = _fts_match_query(query) if query and query.strip() else ''
        if ftsQ:
            rows = conn.execute(
                f'SELECT {cols}, fts.rank '
                'FROM auto_memories_fts AS fts '
                'JOIN auto_memories AS t ON fts.rowid = t.rowid '
                'WHERE auto_memories_fts MATCH ? ORDER BY rank LIMIT ?',
                (ftsQ, max(lim * 4, 50)),
            ).fetchall()
            if rows:
                maxAbs = max((abs(float(r['rank'])) for r in rows if r['rank'] is not None), default=1.0)
                maxAbs = max(maxAbs, 1e-9)
                scored = []
                for r in rows:
                    if _is_expired_row(r):
                        continue
                    rank = abs(float(r['rank'])) if r['rank'] is not None else 0.0
                    norm = min(1.0, rank / maxAbs)
                    decay = _decay_factor(r['updated_at'])
                    conf = float(r['confidence']) if r['confidence'] is not None else _DEFAULT_CONFIDENCE
                    # Generic noise is low-confidence; keep only if still relevant + durable filter handles it.
                    if not durable_only and _GENERIC_PREF_RE.search(str(r['content'] or '')):
                        conf = min(conf, _LOW_CONFIDENCE)
                    scored.append((conf * 0.5 + norm * 0.3 + decay * 0.2, r))
                scored = [s for s in scored if (s[1]['confidence'] is None or float(s[1]['confidence']) >= min_conf) or bool(s[1]['pinned'])]
                scored.sort(key=lambda x: x[0], reverse=True)
                candidates = (
                    [item for item in scored if _is_durable_recall_memory(item[1])]
                    if durable_only
                    else scored
                )
                if candidates:
                    result = []
                    for _, r in candidates[:lim]:
                        item = _row_as_wire(r)
                        item.pop('rank', None)
                        try:
                            item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
                        except (json.JSONDecodeError, TypeError):
                            pass
                        result.append(enrich_memory_for_model(item))
                    # Hybrid recall: merge top semantic (vector) hits that FTS
                    # missed — different wording should still recall the memory.
                    try:
                        from app.services.memory.vector_db import search as _vectorSearch

                        vec_hits = _vectorSearch(query, namespace='auto_memory', top_k=max(lim * 2, 8))
                        seen_ids = {as_int(r.get('id'), 0) for r in result}
                        added = 0
                        for hit in vec_hits:
                            if added >= max(1, lim // 2):
                                break
                            meta = as_dict(hit.get('metadata'), {})
                            key = as_str(meta.get('key'), '')
                            if not key:
                                continue
                            row = conn.execute(
                                'SELECT id FROM auto_memories WHERE key = ?', (key,)
                            ).fetchone()
                            if row is None or as_int(row['id'], 0) in seen_ids:
                                continue
                            mrow = conn.execute(
                                f'SELECT {cols} FROM auto_memories WHERE id = ?', (as_int(row['id'], 0),)
                            ).fetchone()
                            if mrow is None:
                                continue
                            # durable-only recall must not let conversation
                            # summaries/telemetry back in via the vector path
                            # (audit finding).
                            if durable_only and not _is_durable_recall_memory(mrow):
                                continue
                            item = _row_as_wire(mrow)
                            try:
                                item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
                            except (json.JSONDecodeError, TypeError):
                                pass
                            result.append(enrich_memory_for_model(item))
                            seen_ids.add(as_int(row['id'], 0))
                            added += 1
                    except Exception:
                        logger.debug('hybrid vector recall failed', exc_info=True)
                    return result
                # durable_only filtered EVERY FTS hit out — fall through to the
                # LIKE fallback below (different text fields may match durable
                # rows the FTS filter missed; returning [] here skipped it —
                # audit finding).
    except Exception:
        logger.debug('FTS recall failed, falling back to LIKE', exc_info=True)

    # Escape LIKE wildcards in the query so `100%` or `my_note` don't
    # over-match (audit finding).
    escaped = (query or '').strip().replace('%', r'\%').replace('_', r'\_')
    like = f'%{escaped}%'
    if like == '%%':
        return []
    allRows = conn.execute(
        'SELECT id, key, content, category, importance, source, pinned, created_at, updated_at, expires_at, confidence, ttl_days '
        'FROM auto_memories WHERE (expires_at IS NULL OR expires_at > datetime(\'now\')) AND (key LIKE ? ESCAPE \'\\\' OR content LIKE ? ESCAPE \'\\\' ) '
        'ORDER BY importance DESC LIMIT ?',
        (like, like, max(lim * 4, 20)),
    ).fetchall()
    scored = []
    q = query.lower()
    for r in allRows:
        if _is_expired_row(r):
            continue
        if r['confidence'] is not None and float(r['confidence']) < min_conf and not bool(r['pinned']):
            continue
        if _GENERIC_PREF_RE.search(str(r['content'] or '')) and not bool(r['pinned']):
            # Demote generic noise below threshold unless explicitly pinned
            if (float(r['confidence']) if r['confidence'] is not None else _DEFAULT_CONFIDENCE) <= 0.45:
                continue
        score = 0.0
        key = str(r['key'] or '').lower()
        content = str(r['content'] or '').lower()
        if q and q in key:
            score += 0.5
        if q and q in content:
            score += 0.3
        score += (0.0 if r['importance'] is None else float(r['importance'])) * 0.15
        conf = float(r['confidence']) if r['confidence'] is not None else _DEFAULT_CONFIDENCE
        score += conf * 0.15
        if _is_user_source(r['source']):
            score += 0.15
        score += 0.25 * _decay_factor(r['updated_at'])
        if score > 0:
            item = _row_as_wire(r)
            try:
                item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
            except (json.JSONDecodeError, TypeError):
                pass
            if not durable_only or _is_durable_recall_memory(r):
                scored.append((score, enrich_memory_for_model(item)))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [m for __, m in scored[:limit]]


def list_user_added_memories(limit: int = 50) -> list[dict[str, object]]:
    """Return user-authored and pinned memories for every-turn prompt injection."""
    conn = _conn()
    from app.services.memory_store import _row_as_wire

    lim = max(1, min(int(limit), 100))
    rows = conn.execute(
        f'SELECT {_ROW_COLS} '
        "FROM auto_memories WHERE source = 'user' OR pinned = 1 "
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
    folder_id: str = '',
    session_id: str = '',
) -> list[dict[str, object]]:
    """List ``auto_memories`` rows with optional origin / telemetry filters.

    ``origin``: ``all`` | ``recalled`` | ``added``
    ``folder_id``: only memories whose source session lives in that folder
    (project memories); ``session_id``: only memories from one session.
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
    if folder_id:
        clauses.append('s.folder_id = ?')
        params.append(folder_id)
    if session_id:
        clauses.append('m.source_session_id = ?')
        params.append(session_id)
    where = f'WHERE {" AND ".join(clauses)}' if clauses else ''
    joining = bool(folder_id or session_id)
    from_clause = (
        'FROM auto_memories m LEFT JOIN sessions s ON m.source_session_id = s.id'
        if joining
        else 'FROM auto_memories'
    )
    select_cols = ', '.join(f'm.{c}' for c in _ROW_COLS.split(', ')) if joining else _ROW_COLS
    order = 'ORDER BY m.category ASC, m.updated_at DESC, m.id DESC' if joining else 'ORDER BY category ASC, updated_at DESC, id DESC'
    rows = conn.execute(
        f'SELECT {select_cols} {from_clause} {where} {order}',
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
    result = attach_graph_to_items(result)
    return result


_GRAPH_CACHE: dict[str, tuple[float, dict[str, object]]] = {}
_GRAPH_CACHE_TTL_S = 30.0


def _attach_graph(item: dict[str, object]) -> dict[str, object]:
    """Attach lightweight graph context (entity + relation count) with a 30s cache."""
    import time as _time

    key = str(item.get('key') or '')
    if not key:
        return item
    now = _time.time()
    cached = _GRAPH_CACHE.get(key)
    if cached and (now - cached[0]) < _GRAPH_CACHE_TTL_S:
        item['graph'] = cached[1]
        return item
    try:
        from app.services.memory.graph_memory import getEntity, getRelations

        ent = getEntity(key)
        rels = getRelations(key) if ent else []
        graph: dict[str, object] = {
            'entity': ent['type'] if ent else None,
            'entityLabel': ent['metadata'].get('label') if ent and isinstance(ent.get('metadata'), dict) else None,
            'relationCount': len(rels),
            'relations': [
                {'target': r.get('target'), 'type': r.get('type'), 'label': r.get('type')}
                for r in rels[:6]
            ],
        }
        # Observation count (cheap) for badge
        try:
            from app.services.memory.graph_memory import _conn as _gconn

            c = _gconn()
            from app.services.memory.graph_memory import _safeKey

            cnt = c.execute('SELECT COUNT(*) AS c FROM graph_observations WHERE entity_key = ?', (_safeKey(key),)).fetchone()
            graph['observationCount'] = int(cnt['c']) if cnt else 0
        except Exception:
            graph['observationCount'] = 0
        _GRAPH_CACHE[key] = (now, graph)
        item['graph'] = graph
    except Exception:
        item['graph'] = {'relationCount': 0, 'observationCount': 0}
    return item


def attach_graph_to_items(items: list[dict[str, object]]) -> list[dict[str, object]]:
    return [_attach_graph(dict(it)) for it in items]


def list_review_candidates(
    origin: str = 'recalled',
    folder_id: str = '',
    session_id: str = '',
    limit: int = 30,
) -> list[dict[str, object]]:
    """Low-value candidates for bulk keep/remove review (model-checked curation).

    Flags: confidence<0.6 OR expiring within 7d OR importance*decay < 0.35.
    Pinned items are never candidates.
    """
    items = list_all_auto_memories(origin=origin, folder_id=folder_id, session_id=session_id, include_telemetry=False)
    out: list[dict[str, object]] = []
    now = datetime.now(timezone.utc)
    for it in items:
        if bool(it.get('pinned')):
            continue
        conf = float(it.get('confidence') or _DEFAULT_CONFIDENCE)
        imp = float(it.get('importance') or 0.5)
        decay = _decay_factor(it.get('updatedAt') or it.get('updated_at'))
        score = imp * decay
        exp_raw = str(it.get('expiresAt') or it.get('expires_at') or '')
        expiring_soon = False
        if exp_raw:
            ts = _parse_ts(exp_raw)
            if ts is not None:
                if ts.tzinfo is None:
                    ts = ts.replace(tzinfo=timezone.utc)
                delta_days = (ts - now).total_seconds() / 86400.0
                expiring_soon = delta_days <= 7
        is_candidate = conf < 0.6 or expiring_soon or score < 0.35 or _GENERIC_PREF_RE.search(str(it.get('content') or it.get('summary') or '')) is not None
        if is_candidate:
            reason = 'low confidence' if conf < 0.6 else ('expiring soon' if expiring_soon else ('stale' if score < 0.35 else 'generic'))
            it = dict(it)
            it['candidateReason'] = reason
            it['candidateScore'] = round(score, 3)
            out.append(it)
        if len(out) >= max(1, min(limit, 50)):
            break
    return attach_graph_to_items(out)


def get_auto_memory(memory_id: int) -> dict[str, object] | None:
    """Fetch a single ``auto_memories`` row by id."""
    conn = _conn()
    from app.services.memory_store import _row_as_wire

    row = conn.execute(
        f'SELECT {_ROW_COLS} FROM auto_memories WHERE id = ?',
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
    pinned: int | bool | None = None,
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
    if pinned is not None:
        # OR-semantics, consistent with the save paths: an update never unpins.
        sets.append('pinned = MAX(COALESCE(pinned, 0), ?)')
        params.append(1 if pinned else 0)
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


def rememberMemory(
    content: str,
    category: str = 'preference',
    importance: float = 0.7,
    pinned: int | bool = 0,
    session_id: str = '',
) -> dict[str, object] | None:
    """Model-driven memory write — store an intentional fact for later recall.

    A stable key is derived from the normalized content, so repeating the
    same fact refreshes the same row (update-over-duplicate). Returns the
    enriched stored row (or the refreshed near-duplicate twin) so callers
    can surface the id/key back to the model; None when content is empty.
    """
    normalized = _normalize_text(content)
    if not normalized:
        return None
    key = f'remembered_{hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8]}'
    conn = _conn()
    # Exact repeat of a model-written memory reinforces it (importance bump)
    # and never unpins — the same update-over-duplicate semantics as near-dups.
    existing = conn.execute('SELECT id FROM auto_memories WHERE key = ?', (key,)).fetchone()
    if existing is not None:
        now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        pin = 1 if pinned else 0
        conn.execute(
            'UPDATE auto_memories SET importance = MIN(1.0, importance + ?), '
            'pinned = MAX(COALESCE(pinned, 0), ?), updated_at = ? WHERE id = ?',
            (_NEAR_DUP_IMPORTANCE_STEP, pin, now, existing['id']),
        )
        conn.commit()
    else:
        saveAutoMemory(
            key,
            content,
            category=category,
            importance=importance,
            source='auto',
            pinned=pinned,
            session_id=session_id,
        )
    row = conn.execute(
        f'SELECT {_ROW_COLS} FROM auto_memories WHERE key = ?',
        (key,),
    ).fetchone()
    if row is None:
        dup = _find_near_dup(conn, content, exclude_key=key)
        if dup is not None:
            row = conn.execute(
                f'SELECT {_ROW_COLS} FROM auto_memories WHERE id = ?',
                (dup['id'],),
            ).fetchone()
    if row is None:
        return None
    from app.services.memory_store import _row_as_wire

    item = _row_as_wire(row)
    try:
        item['content'] = json.loads(item['content'])  # type: ignore[arg-type]
    except (json.JSONDecodeError, TypeError):
        pass
    return enrich_memory_for_model(item)


def consolidate_conv_summaries() -> int:
    """Merge the oldest conversation summaries into one durable episode memory.

    Once ``_EPISODE_MERGE_MIN`` per-session summaries exist, the oldest
    ``_EPISODE_MERGE_COUNT`` are folded into a single ``episode_<n>`` row
    (importance 0.55) and the originals deleted — bounded, recallable
    cross-session memory without unbounded summary growth. Returns the
    number of merged rows (0 when below the threshold).
    """
    conn = _conn()
    conn.execute('BEGIN IMMEDIATE')
    try:
        rows = conn.execute(
            "SELECT id, content FROM auto_memories "
            "WHERE key LIKE 'conv_summary_%' ORDER BY updated_at ASC"
        ).fetchall()
        if len(rows) < _EPISODE_MERGE_MIN:
            conn.execute('ROLLBACK')
            return 0
        oldest = rows[:_EPISODE_MERGE_COUNT]
        parts = [str(r['content'] or '') for r in oldest]
        merged = '; '.join(parts).strip() or 'Consolidated past conversations'
        # Max-based sequence: survives user deletion of earlier episode rows
        # without colliding with a still-live key.
        seqRow = conn.execute(
            "SELECT COALESCE(MAX(CAST(REPLACE(key, 'episode_', '') AS INTEGER)), 0) AS m "
            "FROM auto_memories WHERE key LIKE 'episode_%'"
        ).fetchone()
        seq = int(seqRow['m']) + 1
        # Insert directly (not via saveAutoMemory): the merged row legitimately
        # contains every remaining summary's tokens, so the near-dup check would
        # absorb it into an existing row. FTS triggers index it on insert.
        now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
        conn.execute(
            'INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (f'episode_{seq}', merged, 'conversation', 0.55, 'auto', 0, now, now),
        )
        ids = [int(r['id']) for r in oldest]
        placeholders = ','.join('?' for _ in ids)
        conn.execute(f'DELETE FROM auto_memories WHERE id IN ({placeholders})', ids)
        conn.commit()
        return len(ids)
    except Exception:
        conn.execute('ROLLBACK')
        raise


def extractAndSaveTodos(
    messages: list[dict[str, object]], session_id: str = ''
) -> list[str]:
    """Extract todo items from assistant messages and save them.

    Merges with any previously stored todos (union by text) so items noted
    in earlier turns are not silently replaced by the current turn's list.
    """
    todos = []
    for msg in messages:
        if msg.get('role') != 'assistant':
            continue
        content = msg.get('content', '')
        if isinstance(content, str):
            items = re.findall('- \\[ \\] (.+)', content)
            todos.extend(items)
    if todos:
        existing = get_memory('todos')
        prior = [str(t) for t in existing] if isinstance(existing, list) else []
        merged = list(dict.fromkeys(prior + todos))
        saveAutoMemory(
            'todos', merged, category='tasks', importance=0.8, source='auto', session_id=session_id
        )
    return todos
