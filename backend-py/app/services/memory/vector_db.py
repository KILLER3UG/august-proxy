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
from typing import Any

from app.lib.paths import data_path

_DB_FILE = data_path("august_vector_memory.json")
_MAX_ENTRIES = 2000
_EMBEDDING_DIM = 384


def _db_path() -> Path:
    env = os.environ.get("AUGUST_VECTOR_DB_FILE")
    return Path(env) if env else _DB_FILE


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _default_db() -> dict[str, Any]:
    return {"version": 1, "entries": []}


def _read() -> dict[str, Any]:
    p = _db_path()
    if not p.exists():
        return _default_db()
    try:
        return json.loads(p.read_text("utf-8"))
    except (json.JSONDecodeError, OSError):
        return _default_db()


def _write(db: dict[str, Any]) -> None:
    db["entries"] = db["entries"][-_MAX_ENTRIES:]
    p = _db_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(db, indent=2), "utf-8")


# ── Embedding ──────────────────────────────────────────────────────────

_encoder = None


def _get_encoder():
    """Lazy-load the sentence transformer model."""
    global _encoder
    if _encoder is not None:
        return _encoder
    try:
        from sentence_transformers import SentenceTransformer
        _encoder = SentenceTransformer("all-MiniLM-L6-v2")
    except ImportError:
        _encoder = None
    return _encoder


def _embed(text: str) -> list[float]:
    """Get embedding vector for text."""
    encoder = _get_encoder()
    if encoder:
        return encoder.encode([text])[0].tolist()
    # Fallback: character-level bag-of-words
    return _char_embed(text)


def _char_embed(text: str) -> list[float]:
    """Character-level fallback embedding (bag of character n-grams)."""
    text = text.lower().strip()[:2000]
    chars = set(text)
    dim = _EMBEDDING_DIM
    vec = [0.0] * dim
    for i, ch in enumerate(sorted(chars)[:dim]):
        vec[i] = text.count(ch) / max(len(text), 1)
    return vec


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(y * y for y in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# ── Public API ─────────────────────────────────────────────────────────


def insert(text: str, metadata: dict[str, Any] | None = None, namespace: str = "default") -> dict[str, Any]:
    """Insert a text entry with its embedding."""
    db = _read()
    import uuid
    entry = {
        "id": f"v_{uuid.uuid4().hex[:12]}",
        "text": text[:5000],
        "embedding": _embed(text),
        "metadata": metadata or {},
        "namespace": namespace,
        "createdAt": _now(),
    }
    db["entries"].append(entry)
    _write(db)
    return entry


def search(query: str, namespace: str = "default", top_k: int = 10) -> list[dict[str, Any]]:
    """Search for similar texts by embedding similarity."""
    db = _read()
    query_vec = _embed(query)
    entries = [e for e in db["entries"] if e.get("namespace") == namespace]

    scored = []
    for e in entries:
        score = _cosine_similarity(query_vec, e.get("embedding", []))
        if score > 0:
            scored.append((score, e))

    scored.sort(key=lambda x: x[0], reverse=True)
    results = []
    for score, entry in scored[:top_k]:
        results.append({"id": entry["id"], "text": entry["text"], "metadata": entry.get("metadata", {}), "score": round(score, 4)})
    return results


def delete(entry_id: str) -> bool:
    """Delete a vector entry by ID."""
    db = _read()
    new_entries = [e for e in db["entries"] if e["id"] != entry_id]
    if len(new_entries) == len(db["entries"]):
        return False
    db["entries"] = new_entries
    _write(db)
    return True


def count(namespace: str = "") -> int:
    """Count entries, optionally by namespace."""
    db = _read()
    if namespace:
        return sum(1 for e in db["entries"] if e.get("namespace") == namespace)
    return len(db["entries"])


def list_namespaces() -> list[str]:
    """List all namespaces."""
    db = _read()
    return sorted(set(e.get("namespace", "default") for e in db["entries"]))


# ── Semantic memory (high-level) ───────────────────────────────────────

_COLLECTIONS_KEY = "semantic_collections"


def _read_collections() -> dict[str, Any]:
    from app.services.memory_store import get_memory
    return get_memory(_COLLECTIONS_KEY) or {}


def _write_collections(data: dict[str, Any]) -> None:
    from app.services.memory_store import save_memory
    save_memory(_COLLECTIONS_KEY, data)


def create_collection(name: str, description: str = "") -> dict[str, Any]:
    """Create a semantic collection (group of related memories)."""
    cols = _read_collections()
    import uuid
    col = {"id": f"sc_{uuid.uuid4().hex[:8]}", "name": name, "description": description, "createdAt": _now()}
    cols[name] = col
    _write_collections(cols)
    return col


def get_collection(name: str) -> dict[str, Any] | None:
    cols = _read_collections()
    return cols.get(name)


def list_collections() -> list[dict[str, Any]]:
    cols = _read_collections()
    return list(cols.values())


def add_to_collection(collection_name: str, text: str, metadata: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Add text to a semantic collection (also stored in vector DB)."""
    col = get_collection(collection_name)
    if not col:
        return None
    entry = insert(text, {**(metadata or {}), "collection": collection_name}, namespace="semantic")
    return entry


def search_collection(collection_name: str, query: str, top_k: int = 5) -> list[dict[str, Any]]:
    """Search within a semantic collection."""
    results = search(query, namespace="semantic", top_k=top_k)
    return [r for r in results if r.get("metadata", {}).get("collection") == collection_name]
