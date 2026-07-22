"""
Vector database — stores and searches text embeddings in SQLite.

SoT: ``vector_entries`` table in august_brain.sqlite.
One-shot import from ``august_vector_memory.json`` if the table is empty.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

from app.json_narrowing import as_dict, as_list, as_str
from app.lib.paths import dataPath

_DBFile = dataPath('august_vector_memory.json')
_MAXEntries = 2000
_EMBEDDINGDim = 384
_db_lock = threading.Lock()
_json_migrated = False

_encoder = None


def _db_path() -> Path:
    env = os.environ.get('AUGUST_VECTOR_DB_FILE')
    return Path(env) if env else _DBFile


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _conn():
    from app.services.memory_schema import create_vector_graph_tables
    from app.services.memory_store import _conn as get_conn

    c = get_conn()
    create_vector_graph_tables(c)
    return c


def _use_char_embed_only() -> bool:
    """Prefer lightweight char embeddings in tests / when forced by env."""
    flag = os.environ.get('AUGUST_VECTOR_CHAR_EMBED', '').strip().lower()
    if flag in ('1', 'true', 'yes', 'on'):
        return True
    # Unit tests: avoid hanging on model download unless explicitly requested.
    if os.environ.get('PYTEST_CURRENT_TEST') and os.environ.get(
        'AUGUST_VECTOR_USE_ST', ''
    ).strip().lower() not in ('1', 'true', 'yes', 'on'):
        return True
    return False


def _getEncoder():
    """Return SentenceTransformer or None. ``False`` sentinel means disabled."""
    global _encoder
    if _encoder is False:
        return None
    if _encoder is not None:
        return _encoder
    if _use_char_embed_only():
        _encoder = False
        return None
    try:
        from sentence_transformers import SentenceTransformer

        _encoder = SentenceTransformer('all-MiniLM-L6-v2')
    except Exception:
        _encoder = False
    return _encoder if _encoder is not False else None


def _embed(text: str) -> list[float]:
    encoder = _getEncoder()
    if encoder is not None:
        try:
            return encoder.encode([text])[0].tolist()
        except Exception:
            pass
    return _charEmbed(text)


def _charEmbed(text: str) -> list[float]:
    text = text.lower().strip()[:2000]
    chars = set(text)
    dim = _EMBEDDINGDim
    vec = [0.0] * dim
    for i, ch in enumerate(sorted(chars)[:dim]):
        vec[i] = text.count(ch) / max(len(text), 1)
    return vec


def _cosineSimilarity(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    dot = sum((x * y for x, y in zip(a, b)))
    normA = sum((x * x for x in a)) ** 0.5
    normB = sum((y * y for y in b)) ** 0.5
    if normA == 0 or normB == 0:
        return 0.0
    return dot / (normA * normB)


def _maybe_migrate_json() -> None:
    """One-shot: import legacy JSON file into SQLite when table is empty."""
    global _json_migrated
    if _json_migrated:
        return
    _json_migrated = True
    conn = _conn()
    n = conn.execute('SELECT COUNT(*) AS c FROM vector_entries').fetchone()['c']
    if n and int(n) > 0:
        return
    p = _db_path()
    if not p.exists():
        return
    try:
        raw = json.loads(p.read_text('utf-8'))
        entries = as_list(as_dict(raw).get('entries') or as_dict(raw).get('vectors'), [])
        for e in entries:
            ed = as_dict(e)
            eid = as_str(ed.get('id')) or f'v_{uuid.uuid4().hex[:12]}'
            emb = as_list(ed.get('embedding'), [])
            meta = as_dict(ed.get('metadata'), {})
            conn.execute(
                """
                INSERT OR IGNORE INTO vector_entries (id, text, embedding, metadata, namespace, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    eid,
                    as_str(ed.get('text'))[:5000],
                    json.dumps(emb),
                    json.dumps(meta),
                    as_str(ed.get('namespace'), 'default') or 'default',
                    as_str(ed.get('createdAt') or ed.get('created_at'), _now()),
                ),
            )
        conn.commit()
    except Exception:
        pass


def insert(text: str, metadata: dict[str, object] | None = None, namespace: str = 'default') -> dict[str, object]:
    """Insert a text entry with its embedding into SQLite."""
    with _db_lock:
        _maybe_migrate_json()
        entry_id = f'v_{uuid.uuid4().hex[:12]}'
        emb = _embed(text)
        created = _now()
        meta = metadata or {}
        conn = _conn()
        conn.execute(
            """
            INSERT INTO vector_entries (id, text, embedding, metadata, namespace, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (entry_id, text[:5000], json.dumps(emb), json.dumps(meta), namespace or 'default', created),
        )
        # Cap table size
        conn.execute(
            """
            DELETE FROM vector_entries WHERE id NOT IN (
                SELECT id FROM vector_entries ORDER BY created_at DESC LIMIT ?
            )
            """,
            (_MAXEntries,),
        )
        conn.commit()
        return {
            'id': entry_id,
            'text': text[:5000],
            'embedding': emb,
            'metadata': meta,
            'namespace': namespace or 'default',
            'createdAt': created,
        }


def search(query: str, namespace: str = 'default', top_k: int = 10) -> list[dict[str, object]]:
    """Search for similar texts by embedding similarity (SQLite load + cosine)."""
    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()
        rows = conn.execute(
            'SELECT id, text, embedding, metadata, namespace FROM vector_entries WHERE namespace = ?',
            (namespace or 'default',),
        ).fetchall()
    queryVec = _embed(query)
    scored: list[tuple[float, dict[str, object]]] = []
    for r in rows:
        emb = []
        try:
            emb = json.loads(r['embedding'] or '[]')
        except (json.JSONDecodeError, TypeError):
            emb = []
        score = _cosineSimilarity(queryVec, cast('list[float]', emb if isinstance(emb, list) else []))
        if score > 0:
            try:
                meta = json.loads(r['metadata'] or '{}')
            except (json.JSONDecodeError, TypeError):
                meta = {}
            scored.append(
                (
                    score,
                    {
                        'id': r['id'],
                        'text': r['text'],
                        'metadata': meta if isinstance(meta, dict) else {},
                        'score': round(score, 4),
                    },
                )
            )
    scored.sort(key=lambda x: x[0], reverse=True)
    return [e for _, e in scored[:top_k]]


def delete(entryId: str) -> bool:
    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()
        cur = conn.execute('DELETE FROM vector_entries WHERE id = ?', (entryId,))
        conn.commit()
        return cur.rowcount > 0


def count(namespace: str = '') -> int:
    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()
        if namespace:
            row = conn.execute(
                'SELECT COUNT(*) AS c FROM vector_entries WHERE namespace = ?', (namespace,)
            ).fetchone()
        else:
            row = conn.execute('SELECT COUNT(*) AS c FROM vector_entries').fetchone()
        return int(row['c'] if row else 0)


def listNamespaces() -> list[str]:
    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()
        rows = conn.execute('SELECT DISTINCT namespace FROM vector_entries ORDER BY namespace').fetchall()
        return [as_str(r['namespace'], 'default') for r in rows]


def _read() -> dict[str, object]:
    """Compatibility shim for dashboard code that read JSON shape."""
    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()
        rows = conn.execute(
            'SELECT id, text, embedding, metadata, namespace, created_at FROM vector_entries'
        ).fetchall()
    entries = []
    for r in rows:
        try:
            emb = json.loads(r['embedding'] or '[]')
        except (json.JSONDecodeError, TypeError):
            emb = []
        try:
            meta = json.loads(r['metadata'] or '{}')
        except (json.JSONDecodeError, TypeError):
            meta = {}
        entries.append(
            {
                'id': r['id'],
                'text': r['text'],
                'embedding': emb,
                'metadata': meta,
                'namespace': r['namespace'],
                'createdAt': r['created_at'],
            }
        )
    return {'version': 2, 'entries': entries}


_COLLECTIONSKey = 'semantic_collections'


def _readCollections() -> dict[str, object]:
    from app.services.memory_store import get_memory

    return as_dict(get_memory(_COLLECTIONSKey), {})


def _writeCollections(data: dict[str, object]) -> None:
    from app.services.memory_store import save_memory

    save_memory(_COLLECTIONSKey, data)


def createCollection(name: str, description: str = '') -> dict[str, object]:
    cols = _readCollections()
    col: dict[str, object] = {
        'id': f'sc_{uuid.uuid4().hex[:8]}',
        'name': name,
        'description': description,
        'createdAt': _now(),
    }
    cols[name] = col
    _writeCollections(cols)
    return col


def getCollection(name: str) -> dict[str, object] | None:
    cols = _readCollections()
    val = cols.get(name)
    return as_dict(val) if isinstance(val, dict) else None


def listCollections() -> list[dict[str, object]]:
    cols = _readCollections()
    return [as_dict(v) for v in cols.values()]


def addToCollection(
    collectionName: str, text: str, metadata: dict[str, object] | None = None
) -> dict[str, object] | None:
    col = getCollection(collectionName)
    if not col:
        return None
    return insert(text, {**(metadata or {}), 'collection': collectionName}, namespace='semantic')


def searchCollection(collectionName: str, query: str, top_k: int = 5) -> list[dict[str, object]]:
    results = search(query, namespace='semantic', top_k=top_k)
    return [r for r in results if as_str(as_dict(r.get('metadata'), {}).get('collection')) == collectionName]
