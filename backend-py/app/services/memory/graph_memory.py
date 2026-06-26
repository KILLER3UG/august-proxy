"""
Graph memory — entity-relationship graph stored as JSON.

Port of backend/services/memory/graph-memory.js (617 lines).
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from app.lib.paths import data_path

_DEFAULT_GRAPH_FILE = data_path("august_graph_memory.json")
_MAX_ENTITIES = 1000
_MAX_RELATIONS = 2500
_MAX_OBSERVATIONS = 4000


def _graph_file() -> Path:
    env = os.environ.get("AUGUST_GRAPH_MEMORY_FILE")
    return Path(env) if env else _DEFAULT_GRAPH_FILE


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _compact(text: Any, max_len: int = 600) -> str:
    return " ".join(str(text or "").split())[:max_len]


def _safe_key(value: str) -> str:
    key = _compact(value, 120).lower()
    key = re.sub(r"[^a-z0-9]+", "_", key).strip("_")
    return key or "unknown"


def _unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for v in values:
        text = _compact(v, 160)
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        result.append(text)
    return result


def _default_graph() -> dict[str, Any]:
    return {"version": 1, "updatedAt": _now(), "entities": [], "relations": [], "observations": []}


def _normalize(raw: Any) -> dict[str, Any]:
    g = raw if isinstance(raw, dict) else _default_graph()
    return {
        "version": int(g.get("version", 1)),
        "updatedAt": g.get("updatedAt"),
        "entities": list(g.get("entities", [])),
        "relations": list(g.get("relations", [])),
        "observations": list(g.get("observations", [])),
    }


def _read() -> dict[str, Any]:
    p = _graph_file()
    if not p.exists():
        return _default_graph()
    try:
        return _normalize(json.loads(p.read_text("utf-8")))
    except (json.JSONDecodeError, OSError):
        return _default_graph()


def _write(graph: dict[str, Any]) -> None:
    g = _normalize(graph)
    g["updatedAt"] = _now()
    g["entities"] = g["entities"][-_MAX_ENTITIES:]
    g["relations"] = g["relations"][-_MAX_RELATIONS:]
    g["observations"] = g["observations"][-_MAX_OBSERVATIONS:]
    p = _graph_file()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(g, indent=2), "utf-8")


# ── Public API ────────────────────────────────────────────────────────


def add_entity(name: str, entity_type: str = "general", metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    g = _read()
    key = _safe_key(name)
    existing = next((e for e in g["entities"] if _safe_key(e.get("name", "")) == key), None)
    if existing:
        existing["updatedAt"] = _now()
        if metadata:
            existing.setdefault("metadata", {}).update(metadata)
        _write(g)
        return existing
    entity = {"id": f"e_{len(g['entities']) + 1}", "name": _compact(name, 200), "type": entity_type, "metadata": metadata or {}, "createdAt": _now(), "updatedAt": _now()}
    g["entities"].append(entity)
    _write(g)
    return entity


def get_entity(name: str) -> dict[str, Any] | None:
    g = _read()
    key = _safe_key(name)
    return next((e for e in g["entities"] if _safe_key(e.get("name", "")) == key), None)


def search_entities(query: str) -> list[dict[str, Any]]:
    g = _read()
    q = query.lower()
    return [e for e in g["entities"] if q in e.get("name", "").lower() or q in str(e.get("metadata", "")).lower()]


def add_relation(source: str, target: str, relation_type: str, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    g = _read()
    src_key, tgt_key = _safe_key(source), _safe_key(target)
    existing = next((r for r in g["relations"] if _safe_key(r.get("source", "")) == src_key and _safe_key(r.get("target", "")) == tgt_key and r.get("type") == relation_type), None)
    if existing:
        existing["updatedAt"] = _now()
        _write(g)
        return existing
    rel = {"id": f"r_{len(g['relations']) + 1}", "source": source, "target": target, "type": relation_type, "metadata": metadata or {}, "createdAt": _now(), "updatedAt": _now()}
    g["relations"].append(rel)
    _write(g)
    return rel


def get_relations(entity_name: str) -> list[dict[str, Any]]:
    g = _read()
    key = _safe_key(entity_name)
    return [r for r in g["relations"] if _safe_key(r.get("source", "")) == key or _safe_key(r.get("target", "")) == key]


def add_observation(entity_name: str, content: str, source: str = "") -> dict[str, Any]:
    g = _read()
    key = _safe_key(entity_name)
    entity = next((e for e in g["entities"] if _safe_key(e.get("name", "")) == key), None)
    if not entity:
        entity = add_entity(entity_name)
    obs = {"id": f"o_{len(g['observations']) + 1}", "entityKey": key, "entityName": entity["name"], "content": _compact(content, 1000), "source": source, "createdAt": _now()}
    g["observations"].append(obs)
    _write(g)
    return obs


def search_observations(query: str) -> list[dict[str, Any]]:
    g = _read()
    q = query.lower()
    return [o for o in g["observations"] if q in o.get("content", "").lower()]


def explore(entity_name: str, depth: int = 1) -> dict[str, Any]:
    """Explore the graph from an entity outward to given depth."""
    g = _read()
    key = _safe_key(entity_name)
    entity = next((e for e in g["entities"] if _safe_key(e.get("name", "")) == key), None)
    if not entity:
        return {"entity": None, "relations": [], "related": []}
    relations = get_relations(entity_name)
    related_names = set()
    for r in relations:
        if _safe_key(r.get("source", "")) != key:
            related_names.add(r["source"])
        if _safe_key(r.get("target", "")) != key:
            related_names.add(r["target"])
    related = [e for e in g["entities"] if e["name"] in related_names]
    return {"entity": entity, "relations": relations, "related": related}


def graph_stats() -> dict[str, Any]:
    g = _read()
    return {"entities": len(g["entities"]), "relations": len(g["relations"]), "observations": len(g["observations"])}
