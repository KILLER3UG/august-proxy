"""
Vector database — stores and searches text embeddings in SQLite.

SoT: ``vector_entries`` table in august_brain.sqlite.
One-shot import from ``august_vector_memory.json`` if the table is empty.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import cast

from app.json_narrowing import as_dict, as_list, as_str
from app.lib.paths import dataPath

try:  # Optional ML acceleration — installed with the 'ml' extra alongside
    # sentence-transformers. Absent ⇒ cached pure-Python cosine fallback.
    import numpy as _np  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - depends on install extras
    _np = None

_DBFile = dataPath('august_vector_memory.json')
# Search cost is O(rows × dim); the batched/cache path below keeps this cheap,
# so the ceiling is now generous. AUGUST_VECTOR_MAX_ENTRIES overrides.
_MAXEntries = 20000
_EMBEDDINGDim = 384
_db_lock = threading.Lock()
_json_migrated = False

_encoder = None

# Embedding-degradation tracking: _embed() falls back to a lossy char-frequency
# vector whenever the sentence encoder is unavailable (import failure, model
# download failure, runtime encode error). That fallback silently degrades
# recall quality — audit finding #6. These flags record WHY so the dashboard
# can surface it instead of failing quietly.
_char_embed_reason = ''
_char_embed_warned = False

# Parsed-row cache: JSON-decoding every stored embedding per query dominated
# search latency (and grew linearly with the cap). The bundle is rebuilt only
# when a write bumps _dataVersion; scoring runs outside the db lock.
_dataVersion = 0
_bundleCache: dict[str, '_VectorBundle'] = {}


def _maxEntries() -> int:
    raw = os.environ.get('AUGUST_VECTOR_MAX_ENTRIES', '').strip()
    if not raw:
        return _MAXEntries
    try:
        return max(10, int(raw))
    except ValueError:
        return _MAXEntries


class _VectorBundle:
    """Parsed namespace rows ready for scoring.

    ``vectors`` is a rectangular float32 ndarray when numpy is available,
    else a list of float lists. Rows are zero-padded to a common width so
    mixed-length historical entries stay comparable.
    """

    __slots__ = ('ids', 'texts', 'metas', 'vectors')

    def __init__(
        self,
        ids: list[str],
        texts: list[str],
        metas: list[dict[str, object]],
        vectors: object,
    ) -> None:
        self.ids = ids
        self.texts = texts
        self.metas = metas
        self.vectors = vectors


def _parseEmbedding(raw: object) -> list[float]:
    try:
        emb = json.loads(str(raw or '[]'))
    except (json.JSONDecodeError, TypeError):
        return []
    return [float(x) for x in emb] if isinstance(emb, list) else []


def _buildBundle(namespace: str) -> _VectorBundle:
    conn = _conn()
    rows = conn.execute(
        'SELECT id, text, embedding, metadata FROM vector_entries WHERE namespace = ?',
        (namespace,),
    ).fetchall()
    ids: list[str] = []
    texts: list[str] = []
    metas: list[dict[str, object]] = []
    vecs: list[list[float]] = []
    width = 0
    for r in rows:
        emb = _parseEmbedding(r['embedding'])
        if not emb:
            continue
        ids.append(str(r['id']))
        texts.append(str(r['text'] or ''))
        try:
            meta = json.loads(r['metadata'] or '{}')
        except (json.JSONDecodeError, TypeError):
            meta = {}
        metas.append(meta if isinstance(meta, dict) else {})
        width = max(width, len(emb))
        vecs.append(emb)
    if width:
        vecs = [v + [0.0] * (width - len(v)) for v in vecs]
    if _np is not None and vecs:
        vectors: object = _np.asarray(vecs, dtype=_np.float32)
    else:
        vectors = vecs
    return _VectorBundle(ids, texts, metas, vectors)


def _bundleFor(namespace: str) -> _VectorBundle:
    """Cached parsed rows for a namespace (caller holds _db_lock)."""
    key = f'{namespace}@{_dataVersion}'
    cached = _bundleCache.get(key)
    if cached is not None:
        return cached
    bundle = _buildBundle(namespace)
    _bundleCache.clear()
    _bundleCache[key] = bundle
    return bundle


def _bumpVersion() -> None:
    global _dataVersion
    _dataVersion += 1


def embeddingStatus() -> dict[str, object]:
    """Report which embedder is active and why, for dashboard health surfaces."""
    using_char = _encoder is False or (not _char_embed_reason and _getEncoder() is None)
    return {
        'encoder': 'char-freq' if using_char else 'minilm',
        'degraded': bool(using_char),
        'reason': _char_embed_reason,
        'dimension': _EMBEDDINGDim,
        'entries': count(),
    }


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
    global _char_embed_warned
    encoder = _getEncoder()
    if encoder is not None:
        try:
            return encoder.encode([text])[0].tolist()
        except Exception as exc:
            # Encoder loaded but failed at runtime — record the reason.
            if not _char_embed_reason:
                globals()['_char_embed_reason'] = f'encode error: {exc}'
    else:
        # _getEncoder() returned None: either char-only mode (env/pytest) or a
        # load failure. Distinguish so the dashboard can say which.
        if not _char_embed_reason:
            if os.environ.get('AUGUST_VECTOR_CHAR_EMBED', '').strip().lower() in (
                '1',
                'true',
                'yes',
                'on',
            ):
                globals()['_char_embed_reason'] = 'forced via AUGUST_VECTOR_CHAR_EMBED'
            elif os.environ.get('PYTEST_CURRENT_TEST'):
                globals()['_char_embed_reason'] = 'pytest char-embed default'
            else:
                globals()['_char_embed_reason'] = (
                    'sentence-transformers unavailable or model load failed'
                )
    if not _char_embed_warned:
        _char_embed_warned = True
        logging.getLogger(__name__).warning(
            'vector recall degraded: using lossy char-frequency embeddings (%s)',
            _char_embed_reason,
        )
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


def insert(text: str, metadata: dict[str, object] | None = None, namespace: str = 'auto_memory') -> dict[str, object]:
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
            (entry_id, text[:5000], json.dumps(emb), json.dumps(meta), namespace or 'auto_memory', created),
        )
        # Cap table size
        conn.execute(
            """
            DELETE FROM vector_entries WHERE id NOT IN (
                SELECT id FROM vector_entries ORDER BY created_at DESC LIMIT ?
            )
            """,
            (_maxEntries(),),
        )
        conn.commit()
        _bumpVersion()
        return {
            'id': entry_id,
            'text': text[:5000],
            'embedding': emb,
            'metadata': meta,
            # Mirror the stored namespace — a 'default' fallback here sent
            # callers reading the result to the wrong namespace (round-4 audit).
            'namespace': namespace or 'auto_memory',
            'createdAt': created,
        }


def search(query: str, namespace: str = 'auto_memory', top_k: int = 10) -> list[dict[str, object]]:
    """Search for similar texts by embedding similarity (cached bundle + cosine).

    Rows are parsed once per data version and scored in one batched matmul
    when numpy is available — previously every query re-decoded every stored
    embedding and ran Python-level cosine under the global lock, which made
    the store ceiling a latency cliff.
    """
    ns = namespace or 'auto_memory'
    with _db_lock:
        _maybe_migrate_json()
        bundle = _bundleFor(ns)
    if not bundle.ids:
        return []
    qvec = _embed(query)
    results: list[tuple[float, int]] = []
    vectors = bundle.vectors
    if _np is not None and isinstance(vectors, _np.ndarray):
        m = vectors
        q = _np.asarray(qvec, dtype=_np.float32)
        width = m.shape[1]
        if len(q) < width:
            q = _np.pad(q, (0, width - len(q)))
        elif len(q) > width:
            q = q[:width]
        qnorm = float(_np.linalg.norm(q))
        if qnorm > 0:
            norms = _np.linalg.norm(m, axis=1)
            denom = norms * qnorm
            sims = _np.zeros(m.shape[0], dtype=_np.float32)
            valid = denom > 0
            sims[valid] = (m[valid] @ q) / denom[valid]
            order = _np.argsort(-sims, kind='stable')
            for i in order.tolist():
                s = round(float(sims[i]), 4)
                if s <= 0 or len(results) >= top_k:
                    break
                results.append((s, i))
        else:
            return []
    else:
        vec_lists = cast('list[list[float]]', vectors)
        for i, emb in enumerate(vec_lists):
            score = _cosineSimilarity(qvec, emb)
            if score > 0:
                results.append((score, i))
        results.sort(key=lambda x: (-x[0], x[1]))
        results = results[:top_k]
    return [
        {
            'id': bundle.ids[i],
            'text': bundle.texts[i],
            'metadata': bundle.metas[i],
            'score': s,
        }
        for s, i in results
    ]


def delete(entryId: str) -> bool:
    global _dataVersion
    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()
        cur = conn.execute('DELETE FROM vector_entries WHERE id = ?', (entryId,))
        conn.commit()
        if cur.rowcount:
            _dataVersion += 1
        return cur.rowcount > 0


def deleteByKey(key: str, namespace: str = 'auto_memory') -> int:
    """Delete every entry whose metadata ``key`` matches in a namespace.

    Mirrors upsert's delete-before-insert scan so stale embeddings can be
    removed without inserting a replacement (used when a memory is demoted or
    superseded rather than updated). Returns the number of entries removed.
    """
    global _dataVersion
    if not key:
        return 0
    ns = namespace or 'auto_memory'
    removed = 0
    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()
        rows = conn.execute(
            'SELECT id, metadata FROM vector_entries WHERE namespace = ?', (ns,)
        ).fetchall()
        for row in rows:
            try:
                meta = json.loads(row['metadata'] or '{}')
            except (json.JSONDecodeError, TypeError):
                continue
            if isinstance(meta, dict) and meta.get('key') == key:
                cur = conn.execute('DELETE FROM vector_entries WHERE id = ?', (row['id'],))
                removed += max(0, int(cur.rowcount))
        if removed:
            conn.commit()
            _dataVersion += 1
    return removed


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


def upsert(text: str, metadata: dict[str, object] | None = None, namespace: str = 'auto_memory') -> dict[str, object]:
    """Insert or replace a vector entry by metadata key.

    If metadata contains a 'key' field, any existing entry with the same
    key in the same namespace is deleted before inserting. This prevents
    stale duplicate embeddings when a memory is updated.

    The delete+insert is atomic (single lock acquisition) to prevent races.
    """
    meta = metadata or {}
    key = meta.get('key')
    ns = namespace or 'auto_memory'

    with _db_lock:
        _maybe_migrate_json()
        conn = _conn()

        # Delete existing entries with same key in this namespace
        if key:
            existing = conn.execute(
                'SELECT id, metadata FROM vector_entries WHERE namespace = ?',
                (ns,),
            ).fetchall()
            for row in existing:
                try:
                    row_meta = json.loads(row['metadata'] or '{}')
                    if row_meta.get('key') == key:
                        conn.execute('DELETE FROM vector_entries WHERE id = ?', (row['id'],))
                except (json.JSONDecodeError, TypeError):
                    pass

        # Insert new entry (inline to stay within the same lock)
        entry_id = f'v_{uuid.uuid4().hex[:12]}'
        emb = _embed(text)
        created = _now()
        conn.execute(
            """
            INSERT INTO vector_entries (id, text, embedding, metadata, namespace, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (entry_id, text[:5000], json.dumps(emb), json.dumps(meta), ns, created),
        )
        # Cap table size
        conn.execute(
            """
            DELETE FROM vector_entries WHERE id NOT IN (
                SELECT id FROM vector_entries ORDER BY created_at DESC LIMIT ?
            )
            """,
            (_maxEntries(),),
        )
        conn.commit()

    _bumpVersion()
    return {
        'id': entry_id,
        'text': text[:5000],
        'metadata': meta,
        'namespace': ns,
        'createdAt': created,
    }


def migrate_default_namespace() -> int:
    """One-time migration: move entries from 'default' to 'auto_memory'.

    Returns count of migrated entries.
    """
    with _db_lock:
        conn = _conn()
        cursor = conn.execute(
            "UPDATE vector_entries SET namespace = 'auto_memory' WHERE namespace = 'default'"
        )
        conn.commit()
        return cursor.rowcount
