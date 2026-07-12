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
	from typing import cast
	from app.jsonUtils import as_bool, as_dict, as_int, as_list, as_str, write_json_atomic
from app.lib.paths import dataPath

_DEFAULTGraphFile = dataPath('august_graph_memory.json')
_MAXEntities = 1000
_MAXRelations = 2500
_MAXObservations = 4000


def _graphFile() -> Path:
    env = os.environ.get('AUGUST_GRAPH_MEMORY_FILE')
    return Path(env) if env else _DEFAULTGraphFile


def _now() -> str:
    return datetime.utcnow().isoformat() + 'Z'


def _compact(text: object, maxLen: int = 600) -> str:
    return ' '.join(str(text or '').split())[:maxLen]


def _safeKey(value: str) -> str:
    key = _compact(value, 120).lower()
    key = re.sub('[^a-z0-9]+', '_', key).strip('_')
    return key or 'unknown'


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


def _defaultGraph() -> dict[str, object]:
    return {'version': 1, 'updatedAt': _now(), 'entities': [], 'relations': [], 'observations': []}


def _normalize(raw: object) -> dict[str, object]:
    g = raw if isinstance(raw, dict) else _defaultGraph()
    return {
        'version': as_int(g.get('version'), 1),
        'updatedAt': g.get('updatedAt'),
        'entities': as_list(g.get('entities'), []),
        'relations': as_list(g.get('relations'), []),
        'observations': as_list(g.get('observations'), []),
    }


def _read() -> dict[str, object]:
    p = _graphFile()
    if not p.exists():
        return _defaultGraph()
    try:
        return _normalize(json.loads(p.read_text('utf-8')))
    except (json.JSONDecodeError, OSError):
        return _defaultGraph()


def _write(graph: dict[str, object]) -> None:
    g = _normalize(graph)
    g['updatedAt'] = _now()
    g['entities'] = as_list(g['entities'])[-_MAXEntities:]
    g['relations'] = as_list(g['relations'])[-_MAXRelations:]
    g['observations'] = as_list(g['observations'])[-_MAXObservations:]
    p = _graphFile()
    p.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(p, g, indent=2)


def addEntity(name: str, entityType: str = 'general', metadata: dict[str, object] | None = None) -> dict[str, object]:
    g = _read()
    key = _safeKey(name)
    entities = cast(list[dict[str, object]], as_list(g['entities']))
    existing = next((e for e in entities if _safeKey(as_str(e.get('name'), '')) == key), None)
    if existing:
        existing['updatedAt'] = _now()
        if metadata:
            as_dict(existing.setdefault('metadata', {})).update(metadata)
        _write(g)
        return existing
    entity: dict[str, object] = {
        'id': f'e_{len(entities) + 1}',
        'name': _compact(name, 200),
        'type': entityType,
        'metadata': metadata or {},
        'createdAt': _now(),
        'updatedAt': _now(),
    }
    entities.append(entity)
    _write(g)
    return entity


def getEntity(name: str) -> dict[str, object] | None:
    g = _read()
    key = _safeKey(name)
    return next(
        (
            e
            for e in cast(list[dict[str, object]], as_list(g['entities']))
            if _safeKey(as_str(e.get('name'), '')) == key
        ),
        None,
    )


def searchEntities(query: str) -> list[dict[str, object]]:
    g = _read()
    q = query.lower()
    entities = cast(list[dict[str, object]], as_list(g['entities']))
    return [
        e for e in entities if q in as_str(e.get('name'), '').lower() or q in str(as_dict(e.get('metadata'))).lower()
    ]


def addRelation(
    source: str, target: str, relationType: str, metadata: dict[str, object] | None = None
) -> dict[str, object]:
    g = _read()
    srcKey, tgtKey = (_safeKey(source), _safeKey(target))
    relations = cast(list[dict[str, object]], as_list(g['relations']))
    existing = next(
        (
            r
            for r in relations
            if _safeKey(as_str(r.get('source'), '')) == srcKey
            and _safeKey(as_str(r.get('target'), '')) == tgtKey
            and (as_str(r.get('type')) == relationType)
        ),
        None,
    )
    if existing:
        existing['updatedAt'] = _now()
        _write(g)
        return existing
    rel: dict[str, object] = {
        'id': f'r_{len(relations) + 1}',
        'source': source,
        'target': target,
        'type': relationType,
        'metadata': metadata or {},
        'createdAt': _now(),
        'updatedAt': _now(),
    }
    relations.append(rel)
    _write(g)
    return rel


def getRelations(entityName: str) -> list[dict[str, object]]:
    g = _read()
    key = _safeKey(entityName)
    relations = cast(list[dict[str, object]], as_list(g['relations']))
    return [
        r
        for r in relations
        if _safeKey(as_str(r.get('source'), '')) == key or _safeKey(as_str(r.get('target'), '')) == key
    ]


def addObservation(entityName: str, content: str, source: str = '') -> dict[str, object]:
    g = _read()
    key = _safeKey(entityName)
    entities = cast(list[dict[str, object]], as_list(g['entities']))
    entity = next((e for e in entities if _safeKey(as_str(e.get('name'), '')) == key), None)
    if not entity:
        entity = addEntity(entityName)
    observations = cast(list[dict[str, object]], as_list(g['observations']))
    obs = {
        'id': f'o_{len(observations) + 1}',
        'entityKey': key,
        'entityName': entity['name'],
        'content': _compact(content, 1000),
        'source': source,
        'createdAt': _now(),
    }
    observations.append(obs)
    _write(g)
    return obs


def searchObservations(query: str) -> list[dict[str, object]]:
    g = _read()
    q = query.lower()
    observations = cast(list[dict[str, object]], as_list(g['observations']))
    return [o for o in observations if q in as_str(o.get('content'), '').lower()]


def explore(entityName: str, depth: int = 1) -> dict[str, object]:
    """Explore the graph from an entity outward to given depth."""
    g = _read()
    key = _safeKey(entityName)
    entities = cast(list[dict[str, object]], as_list(g['entities']))
    entity = next((e for e in entities if _safeKey(as_str(e.get('name'), '')) == key), None)
    if not entity:
        return {'entity': None, 'relations': [], 'related': []}
    relations = getRelations(entityName)
    relatedNames = set()
    for r in relations:
        if _safeKey(as_str(r.get('source'), '')) != key:
            relatedNames.add(r['source'])
        if _safeKey(as_str(r.get('target'), '')) != key:
            relatedNames.add(r['target'])
    related = [e for e in entities if e['name'] in relatedNames]
    return {'entity': entity, 'relations': relations, 'related': related}


def graphStats() -> dict[str, object]:
    g = _read()
    return {
        'entities': len(as_list(g['entities'])),
        'relations': len(as_list(g['relations'])),
        'observations': len(as_list(g['observations'])),
    }
