"""
Vector database — stores and searches text embeddings.

Port of backend/services/memory/vector-db.js (459 lines).

Uses sentence-transformers when available, falls back to character-level
heuristics for similarity search.
"""

from __future__ import annotations
from typing import cast
import json
import os
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from app.jsonUtils import as_dict, as_list, as_str
from app.lib.paths import dataPath

_DBFile = dataPath('august_vector_memory.json')
_MAXEntries = 2000
_EMBEDDINGDim = 384


def _dbPath() -> Path:
    env = os.environ.get('AUGUST_VECTOR_DB_FILE')
    return Path(env) if env else _DBFile


def _now() -> str:
    return datetime.utcnow().isoformat() + 'Z'


def _defaultDb() -> dict[str, object]:
    return {'version': 1, 'entries': []}


def _read() -> dict[str, object]:
    p = _dbPath()
    if not p.exists():
        return _defaultDb()
    try:
        return json.loads(p.read_text('utf-8'))
    except (json.JSONDecodeError, OSError):
        return _defaultDb()


def _write(db: dict[str, object]) -> None:
    db['entries'] = as_list(db['entries'])[-_MAXEntries:]
    p = _dbPath()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(db, indent=2), 'utf-8')


_encoder = None


def _getEncoder():
    """Lazy-load the sentence transformer model."""
    global _encoder
    if _encoder is not None:
        return _encoder
    try:
        from sentence_transformers import SentenceTransformer

        _encoder = SentenceTransformer('all-MiniLM-L6-v2')
    except ImportError:
        _encoder = None
    return _encoder


def _embed(text: str) -> list[float]:
    """Get embedding vector for text."""
    encoder = _getEncoder()
    if encoder:
        return encoder.encode([text])[0].tolist()
    return _charEmbed(text)


def _charEmbed(text: str) -> list[float]:
    """Character-level fallback embedding (bag of character n-grams)."""
    text = text.lower().strip()[:2000]
    chars = set(text)
    dim = _EMBEDDINGDim
    vec = [0.0] * dim
    for i, ch in enumerate(sorted(chars)[:dim]):
        vec[i] = text.count(ch) / max(len(text), 1)
    return vec


def _cosineSimilarity(a: list[float], b: list[float]) -> float:
    dot = sum((x * y for x, y in zip(a, b)))
    normA = sum((x * x for x in a)) ** 0.5
    normB = sum((y * y for y in b)) ** 0.5
    if normA == 0 or normB == 0:
        return 0.0
    return dot / (normA * normB)


def insert(text: str, metadata: dict[str, object] | None = None, namespace: str = 'default') -> dict[str, object]:
    """Insert a text entry with its embedding."""
    db = _read()
    import uuid

    entry: dict[str, object] = {
        'id': f'v_{uuid.uuid4().hex[:12]}',
        'text': text[:5000],
        'embedding': _embed(text),
        'metadata': metadata or {},
        'namespace': namespace,
        'createdAt': _now(),
    }
    as_list(db['entries']).append(entry)
    _write(db)
    return entry


def search(query: str, namespace: str = 'default', top_k: int = 10) -> list[dict[str, object]]:
    """Search for similar texts by embedding similarity."""
    db = _read()
    queryVec = _embed(query)
    entries = [e for e in as_list(db['entries']) if as_str(as_dict(e).get('namespace')) == namespace]
    scored = []
    for e in entries:
        score = _cosineSimilarity(queryVec, cast('list[float]', as_list(as_dict(e).get('embedding'), [])))
        if score > 0:
            scored.append((score, e))
    scored.sort(key=lambda x: x[0], reverse=True)
    results = []
    for score, entry in scored[:top_k]:
        entryDict = as_dict(entry)
        results.append(
            {
                'id': entryDict.get('id'),
                'text': entryDict.get('text'),
                'metadata': as_dict(entryDict.get('metadata'), {}),
                'score': round(score, 4),
            }
        )
    return results


def delete(entryId: str) -> bool:
    """Delete a vector entry by ID."""
    db = _read()
    newEntries = [e for e in as_list(db['entries']) if as_str(as_dict(e).get('id')) != entryId]
    if len(newEntries) == len(as_list(db['entries'])):
        return False
    db['entries'] = newEntries
    _write(db)
    return True


def count(namespace: str = '') -> int:
    """Count entries, optionally by namespace."""
    db = _read()
    if namespace:
        return len([e for e in as_list(db['entries']) if as_str(as_dict(e).get('namespace')) == namespace])
    return len(as_list(db['entries']))


def listNamespaces() -> list[str]:
    """List all namespaces."""
    db = _read()
    return sorted(set(as_str(as_dict(e).get('namespace'), 'default') for e in as_list(db['entries'])))


_COLLECTIONSKey = 'semantic_collections'


def _readCollections() -> dict[str, object]:
    from app.services.memory_store import getMemory

    return as_dict(getMemory(_COLLECTIONSKey), {})


def _writeCollections(data: dict[str, object]) -> None:
    from app.services.memory_store import saveMemory

    saveMemory(_COLLECTIONSKey, data)


def createCollection(name: str, description: str = '') -> dict[str, object]:
    """Create a semantic collection (group of related memories)."""
    cols = _readCollections()
    import uuid

    col: dict[str, object] = {'id': f'sc_{uuid.uuid4().hex[:8]}', 'name': name, 'description': description, 'createdAt': _now()}
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
    """Add text to a semantic collection (also stored in vector DB)."""
    col = getCollection(collectionName)
    if not col:
        return None
    entry = insert(text, {**(metadata or {}), 'collection': collectionName}, namespace='semantic')
    return entry


def searchCollection(collectionName: str, query: str, top_k: int = 5) -> list[dict[str, object]]:
    """Search within a semantic collection."""
    results = search(query, namespace='semantic', top_k=top_k)
    return [r for r in results if as_str(as_dict(r.get('metadata'), {}).get('collection')) == collectionName]
