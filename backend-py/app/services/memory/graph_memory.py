"""
Graph memory — entity-relationship graph stored in SQLite.

SoT tables: graph_entities, graph_relations, graph_observations.
One-shot import from ``august_graph_memory.json`` when tables are empty.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

from app.json_narrowing import as_dict, as_list, as_str
from app.lib.paths import dataPath

_DEFAULTGraphFile = dataPath('august_graph_memory.json')
_MAXEntities = 1000
_MAXRelations = 2500
_MAXObservations = 4000
# RLock: addRelation/addObservation call addEntity while already holding the lock.
_graph_lock = threading.RLock()
_json_migrated = False


def _graphFile() -> Path:
    env = os.environ.get('AUGUST_GRAPH_MEMORY_FILE')
    return Path(env) if env else _DEFAULTGraphFile


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _compact(text: object, maxLen: int = 600) -> str:
    return ' '.join(str(text or '').split())[:maxLen]


def _safeKey(value: str) -> str:
    key = _compact(value, 120).lower()
    key = re.sub('[^a-z0-9]+', '_', key).strip('_')
    return key or 'unknown'


def entityKey(value: str) -> str:
    """Public stable id for an entity name (UI graph nodes)."""
    return _safeKey(value)


def _conn():
    from app.services.memory_store import _conn as get_conn
    from app.services.memory_schema import create_vector_graph_tables

    c = get_conn()
    create_vector_graph_tables(c)
    return c


def _maybe_migrate_json() -> None:
    global _json_migrated
    if _json_migrated:
        return
    _json_migrated = True
    conn = _conn()
    n = conn.execute('SELECT COUNT(*) AS c FROM graph_entities').fetchone()['c']
    if n and int(n) > 0:
        return
    p = _graphFile()
    if not p.exists():
        return
    try:
        raw = json.loads(p.read_text('utf-8'))
        g = raw if isinstance(raw, dict) else {}
        for e in as_list(g.get('entities'), []):
            ed = as_dict(e)
            name = as_str(ed.get('name'))
            if not name:
                continue
            key = _safeKey(name)
            conn.execute(
                """
                INSERT OR IGNORE INTO graph_entities (name_key, name, entity_type, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    key,
                    name,
                    as_str(ed.get('type'), 'general') or 'general',
                    json.dumps(as_dict(ed.get('metadata'), {})),
                    as_str(ed.get('createdAt') or ed.get('created_at'), _now()),
                    as_str(ed.get('updatedAt') or ed.get('updated_at'), _now()),
                ),
            )
        for r in as_list(g.get('relations'), []):
            rd = as_dict(r)
            src, tgt = as_str(rd.get('source')), as_str(rd.get('target'))
            rtype = as_str(rd.get('type'), 'related')
            if not src or not tgt:
                continue
            conn.execute(
                """
                INSERT OR IGNORE INTO graph_relations (source_key, target_key, relation_type, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    _safeKey(src),
                    _safeKey(tgt),
                    rtype,
                    json.dumps(as_dict(rd.get('metadata'), {})),
                    as_str(rd.get('createdAt'), _now()),
                    as_str(rd.get('updatedAt'), _now()),
                ),
            )
        for o in as_list(g.get('observations'), []):
            od = as_dict(o)
            ekey = as_str(od.get('entityKey') or od.get('entity_key'))
            if not ekey:
                ekey = _safeKey(as_str(od.get('entityName') or od.get('entity_name')))
            content = as_str(od.get('content'))
            if not content:
                continue
            conn.execute(
                """
                INSERT INTO graph_observations (entity_key, content, metadata, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (
                    ekey,
                    content,
                    json.dumps({'source': as_str(od.get('source'))}),
                    as_str(od.get('createdAt'), _now()),
                ),
            )
        conn.commit()
    except Exception:
        pass


def _entity_row(r) -> dict[str, object]:
    try:
        meta = json.loads(r['metadata'] or '{}')
    except (json.JSONDecodeError, TypeError):
        meta = {}
    return {
        'name': r['name'],
        'type': r['entity_type'],
        'metadata': meta if isinstance(meta, dict) else {},
        'createdAt': r['created_at'],
        'updatedAt': r['updated_at'],
    }


def addEntity(name: str, entityType: str = 'general', metadata: dict[str, object] | None = None) -> dict[str, object]:
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        key = _safeKey(name)
        now = _now()
        existing = conn.execute('SELECT * FROM graph_entities WHERE name_key = ?', (key,)).fetchone()
        if existing:
            meta = as_dict(json.loads(existing['metadata'] or '{}') if existing['metadata'] else {}, {})
            if metadata:
                meta.update(metadata)
            conn.execute(
                'UPDATE graph_entities SET metadata = ?, updated_at = ?, entity_type = COALESCE(?, entity_type) WHERE name_key = ?',
                (json.dumps(meta), now, entityType, key),
            )
            conn.commit()
            return {
                'name': existing['name'],
                'type': entityType or existing['entity_type'],
                'metadata': meta,
                'createdAt': existing['created_at'],
                'updatedAt': now,
            }
        # Cap entities
        count = conn.execute('SELECT COUNT(*) AS c FROM graph_entities').fetchone()['c']
        if int(count) >= _MAXEntities:
            conn.execute(
                'DELETE FROM graph_entities WHERE name_key IN (SELECT name_key FROM graph_entities ORDER BY updated_at ASC LIMIT 1)'
            )
        ent = {
            'name': name,
            'type': entityType or 'general',
            'metadata': metadata or {},
            'createdAt': now,
            'updatedAt': now,
        }
        conn.execute(
            """
            INSERT INTO graph_entities (name_key, name, entity_type, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (key, name, entityType or 'general', json.dumps(metadata or {}), now, now),
        )
        conn.commit()
        return ent


def getEntity(name: str) -> dict[str, object] | None:
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        r = conn.execute('SELECT * FROM graph_entities WHERE name_key = ?', (_safeKey(name),)).fetchone()
        return _entity_row(r) if r else None


def searchEntities(query: str) -> list[dict[str, object]]:
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        q = f'%{query.lower()}%'
        rows = conn.execute(
            'SELECT * FROM graph_entities WHERE lower(name) LIKE ? OR lower(metadata) LIKE ? LIMIT 50',
            (q, q),
        ).fetchall()
        return [_entity_row(r) for r in rows]


def addRelation(
    source: str, target: str, relationType: str, metadata: dict[str, object] | None = None
) -> dict[str, object]:
    with _graph_lock:
        _maybe_migrate_json()
        # Ensure endpoints exist
        addEntity(source)
        addEntity(target)
        conn = _conn()
        src_key, tgt_key = _safeKey(source), _safeKey(target)
        now = _now()
        existing = conn.execute(
            """
            SELECT * FROM graph_relations
            WHERE source_key = ? AND target_key = ? AND relation_type = ?
            """,
            (src_key, tgt_key, relationType),
        ).fetchone()
        if existing:
            conn.execute(
                'UPDATE graph_relations SET updated_at = ?, metadata = ? WHERE id = ?',
                (now, json.dumps(metadata or json.loads(existing['metadata'] or '{}')), existing['id']),
            )
            conn.commit()
            return {
                'id': f"r_{existing['id']}",
                'source': source,
                'target': target,
                'type': relationType,
                'metadata': metadata or {},
                'createdAt': existing['created_at'],
                'updatedAt': now,
            }
        count = conn.execute('SELECT COUNT(*) AS c FROM graph_relations').fetchone()['c']
        if int(count) >= _MAXRelations:
            conn.execute('DELETE FROM graph_relations WHERE id = (SELECT id FROM graph_relations ORDER BY updated_at ASC LIMIT 1)')
        cur = conn.execute(
            """
            INSERT INTO graph_relations (source_key, target_key, relation_type, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (src_key, tgt_key, relationType, json.dumps(metadata or {}), now, now),
        )
        conn.commit()
        return {
            'id': f'r_{cur.lastrowid}',
            'source': source,
            'target': target,
            'type': relationType,
            'metadata': metadata or {},
            'createdAt': now,
            'updatedAt': now,
        }


def getRelations(entityName: str) -> list[dict[str, object]]:
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        key = _safeKey(entityName)
        rows = conn.execute(
            'SELECT * FROM graph_relations WHERE source_key = ? OR target_key = ?',
            (key, key),
        ).fetchall()
        # Resolve names
        key_to_name: dict[str, str] = {}
        for r in rows:
            for k in (r['source_key'], r['target_key']):
                if k not in key_to_name:
                    er = conn.execute('SELECT name FROM graph_entities WHERE name_key = ?', (k,)).fetchone()
                    key_to_name[k] = er['name'] if er else k
        out = []
        for r in rows:
            try:
                meta = json.loads(r['metadata'] or '{}')
            except (json.JSONDecodeError, TypeError):
                meta = {}
            out.append(
                {
                    'id': f"r_{r['id']}",
                    'source': key_to_name.get(r['source_key'], r['source_key']),
                    'target': key_to_name.get(r['target_key'], r['target_key']),
                    'type': r['relation_type'],
                    'metadata': meta,
                    'createdAt': r['created_at'],
                    'updatedAt': r['updated_at'],
                }
            )
        return out


def addObservation(entityName: str, content: str, source: str = '') -> dict[str, object]:
    with _graph_lock:
        _maybe_migrate_json()
        addEntity(entityName)
        conn = _conn()
        key = _safeKey(entityName)
        now = _now()
        count = conn.execute('SELECT COUNT(*) AS c FROM graph_observations').fetchone()['c']
        if int(count) >= _MAXObservations:
            conn.execute(
                'DELETE FROM graph_observations WHERE id = (SELECT id FROM graph_observations ORDER BY created_at ASC LIMIT 1)'
            )
        cur = conn.execute(
            """
            INSERT INTO graph_observations (entity_key, content, metadata, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (key, _compact(content, 1000), json.dumps({'source': source}), now),
        )
        conn.commit()
        return {
            'id': f'o_{cur.lastrowid}',
            'entityKey': key,
            'entityName': entityName,
            'content': _compact(content, 1000),
            'source': source,
            'createdAt': now,
        }


def searchObservations(query: str) -> list[dict[str, object]]:
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        q = f'%{query.lower()}%'
        rows = conn.execute(
            'SELECT * FROM graph_observations WHERE lower(content) LIKE ? LIMIT 50', (q,)
        ).fetchall()
        out = []
        for r in rows:
            try:
                meta = json.loads(r['metadata'] or '{}')
            except (json.JSONDecodeError, TypeError):
                meta = {}
            out.append(
                {
                    'id': f"o_{r['id']}",
                    'entityKey': r['entity_key'],
                    'content': r['content'],
                    'source': as_str(as_dict(meta).get('source')),
                    'createdAt': r['created_at'],
                }
            )
        return out


def explore(entityName: str, depth: int = 1) -> dict[str, object]:
    entity = getEntity(entityName)
    if not entity:
        return {'entity': None, 'relations': [], 'related': []}
    relations = getRelations(entityName)
    key = _safeKey(entityName)
    related_names: set[str] = set()
    for r in relations:
        if _safeKey(as_str(r.get('source'), '')) != key:
            related_names.add(as_str(r.get('source')))
        if _safeKey(as_str(r.get('target'), '')) != key:
            related_names.add(as_str(r.get('target')))
    related = [e for n in related_names if (e := getEntity(n))]
    return {'entity': entity, 'relations': relations, 'related': related}


def graphStats() -> dict[str, object]:
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        return {
            'entities': int(conn.execute('SELECT COUNT(*) AS c FROM graph_entities').fetchone()['c']),
            'relations': int(conn.execute('SELECT COUNT(*) AS c FROM graph_relations').fetchone()['c']),
            'observations': int(conn.execute('SELECT COUNT(*) AS c FROM graph_observations').fetchone()['c']),
        }


def entityTypeCounts() -> dict[str, int]:
    """Return entity_type → count for dashboard legends."""
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        rows = conn.execute(
            'SELECT entity_type, COUNT(*) AS c FROM graph_entities GROUP BY entity_type'
        ).fetchall()
        out: dict[str, int] = {}
        for r in rows:
            out[str(r['entity_type'] or 'general')] = int(r['c'])
        return out


def listEntities(limit: int = 50) -> list[dict[str, object]]:
    """Most recently updated entities (for default graph neighborhood)."""
    lim = max(1, min(200, int(limit or 50)))
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        rows = conn.execute(
            'SELECT * FROM graph_entities ORDER BY updated_at DESC LIMIT ?',
            (lim,),
        ).fetchall()
        return [_entity_row(r) for r in rows]


def listRelationsForKeys(name_keys: list[str], limit: int = 200) -> list[dict[str, object]]:
    """Relations where source or target is in name_keys."""
    if not name_keys:
        return []
    lim = max(1, min(500, int(limit or 200)))
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        placeholders = ','.join('?' for _ in name_keys)
        rows = conn.execute(
            f"""
            SELECT * FROM graph_relations
            WHERE source_key IN ({placeholders}) OR target_key IN ({placeholders})
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (*name_keys, *name_keys, lim),
        ).fetchall()
        key_to_name: dict[str, str] = {}
        for r in rows:
            for k in (r['source_key'], r['target_key']):
                if k not in key_to_name:
                    er = conn.execute(
                        'SELECT name FROM graph_entities WHERE name_key = ?', (k,)
                    ).fetchone()
                    key_to_name[k] = er['name'] if er else k
        out: list[dict[str, object]] = []
        for r in rows:
            try:
                meta = json.loads(r['metadata'] or '{}')
            except (json.JSONDecodeError, TypeError):
                meta = {}
            src_name = key_to_name.get(r['source_key'], r['source_key'])
            tgt_name = key_to_name.get(r['target_key'], r['target_key'])
            out.append(
                {
                    'id': f"r_{r['id']}",
                    'source': src_name,
                    'target': tgt_name,
                    'type': r['relation_type'],
                    'metadata': meta,
                    'createdAt': r['created_at'],
                    'updatedAt': r['updated_at'],
                }
            )
        return out


def _read() -> dict[str, object]:
    """Compatibility shape for callers that expect the old JSON graph."""
    with _graph_lock:
        _maybe_migrate_json()
        conn = _conn()
        entities = [_entity_row(r) for r in conn.execute('SELECT * FROM graph_entities').fetchall()]
        relations = []
        for r in conn.execute('SELECT * FROM graph_relations').fetchall():
            try:
                meta = json.loads(r['metadata'] or '{}')
            except (json.JSONDecodeError, TypeError):
                meta = {}
            src = conn.execute('SELECT name FROM graph_entities WHERE name_key = ?', (r['source_key'],)).fetchone()
            tgt = conn.execute('SELECT name FROM graph_entities WHERE name_key = ?', (r['target_key'],)).fetchone()
            relations.append(
                {
                    'id': f"r_{r['id']}",
                    'source': src['name'] if src else r['source_key'],
                    'target': tgt['name'] if tgt else r['target_key'],
                    'type': r['relation_type'],
                    'metadata': meta,
                }
            )
        observations = []
        for o in conn.execute('SELECT * FROM graph_observations').fetchall():
            try:
                meta = json.loads(o['metadata'] or '{}')
            except (json.JSONDecodeError, TypeError):
                meta = {}
            observations.append(
                {
                    'id': f"o_{o['id']}",
                    'entityKey': o['entity_key'],
                    'content': o['content'],
                    'source': as_str(as_dict(meta).get('source')),
                    'createdAt': o['created_at'],
                }
            )
        return {
            'version': 2,
            'updatedAt': _now(),
            'entities': entities,
            'relations': relations,
            'observations': observations,
        }
