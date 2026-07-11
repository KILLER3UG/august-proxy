"""
Vector database — stores and searches text embeddings.

Port of backend/services/memory/vector-db.js (459 lines).

Uses sentence-transformers when available, falls back to character-level
heuristics for similarity search.
"""
from __future__ import annotations
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
    db['entries'] = db['entries'][-_MAXEntries:]
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

def insert(text: str, metadata: dict[str, object] | None=None, namespace: str='default') -> dict[str, object]:
    """Insert a text entry with its embedding."""
    db = _read()
    import uuid
    entry = {'id': f'v_{uuid.uuid4().hex[:12]}', 'text': text[:5000], 'embedding': _embed(text), 'metadata': metadata or {}, 'namespace': namespace, 'createdAt': _now()}
    db['entries'].append(entry)
    _write(db)
    return entry

def search(query: str, namespace: str='default', topK: int=10) -> list[dict[str, object]]:
    """Search for similar texts by embedding similarity."""
    db = _read()
    queryVec = _embed(query)
    entries = [e for e in db['entries'] if as_str(e.get('namespace')) == namespace]
    scored = []
    for e in entries:
        score = _cosineSimilarity(queryVec, as_list(e.get('embedding'), []))
        if score > 0:
            scored.append((score, e))
    scored.sort(key=lambda x: x[0], reverse=True)
    results = []
    for score, entry in scored[:topK]:
        results.append({'id': entry['id'], 'text': entry['text'], 'metadata': as_dict(entry.get('metadata'), {}), 'score': round(score, 4)})
    return results

def delete(entryId: str) -> bool:
    """Delete a vector entry by ID."""
    db = _read()
    newEntries = [e for e in db['entries'] if e['id'] != entryId]
    if len(newEntries) == len(db['entries']):
        return False
    db['entries'] = newEntries
    _write(db)
    return True

def count(namespace: str='') -> int:
    """Count entries, optionally by namespace."""
    db = _read()
    if namespace:
        return sum((1 for e in db['entries'] if as_str(e.get('namespace')) == namespace))
    return len(db['entries'])

def listNamespaces() -> list[str]:
    """List all namespaces."""
    db = _read()
    return sorted(set((as_str(e.get('namespace'), 'default') for e in db['entries'])))
_COLLECTIONSKey = 'semantic_collections'

def _readCollections() -> dict[str, object]:
    from app.services.memory_store import getMemory
    return getMemory(_COLLECTIONSKey) or {}

def _writeCollections(data: dict[str, object]) -> None:
    from app.services.memory_store import saveMemory
    saveMemory(_COLLECTIONSKey, data)

def createCollection(name: str, description: str='') -> dict[str, object]:
    """Create a semantic collection (group of related memories)."""
    cols = _readCollections()
    import uuid
    col = {'id': f'sc_{uuid.uuid4().hex[:8]}', 'name': name, 'description': description, 'createdAt': _now()}
    cols[name] = col
    _writeCollections(cols)
    return col

def getCollection(name: str) -> dict[str, object] | None:
    cols = _readCollections()
    return cols.get(name)

def listCollections() -> list[dict[str, object]]:
    cols = _readCollections()
    return list(cols.values())

def addToCollection(collectionName: str, text: str, metadata: dict[str, object] | None=None) -> dict[str, object] | None:
    """Add text to a semantic collection (also stored in vector DB)."""
    col = getCollection(collectionName)
    if not col:
        return None
    entry = insert(text, {**(metadata or {}), 'collection': collectionName}, namespace='semantic')
    return entry

def searchCollection(collectionName: str, query: str, topK: int=5) -> list[dict[str, object]]:
    """Search within a semantic collection."""
    results = search(query, namespace='semantic', top_k=topK)
    return [r for r in results if as_str(as_dict(r.get('metadata'), {}).get('collection')) == collectionName]