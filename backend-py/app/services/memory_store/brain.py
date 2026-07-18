"""brain_query tool domain (multi-store FTS/SQL)."""
from __future__ import annotations
import json
from app.adapters.case_converters import camelToSnake
from app.json_narrowing import as_str, as_list
from app.services.memory_conn import conn as _conn
from app.services.memory_store.kv import _fts_match_query
from app.services.memory_store.wire import _row_as_wire

_BRAINStores: dict[str, dict[str, object]] = {
    'memory': {
        'table': 'memory_store',
        'fts': 'memory_store_fts',
        'columns': 'key, value, updated_at',
        'search_cols': ['key', 'value'],
        'label': 'key-value memory store',
    },
    'autoMemories': {
        'table': 'auto_memories',
        'fts': 'auto_memories_fts',
        'columns': 'id, key, content, category, importance, created_at',
        'search_cols': ['key', 'content'],
        'label': 'auto-captured memories',
    },
    'heuristics': {
        'table': 'learned_heuristics',
        'fts': None,
        'columns': 'id, rule, source, category, created_at, updated_at',
        'search_cols': ['rule', 'source'],
        'label': 'learned behavioral rules',
    },
    'facts': {
        'table': 'facts',
        'fts': None,
        'columns': 'id, fact_key, fact_value, category, source, confidence, created_at, updated_at',
        'search_cols': ['fact_key', 'fact_value'],
        'label': 'structured semantic facts',
    },
    'sessions': {
        'table': 'sessions',
        'fts': None,
        'columns': 'id, title, started_at, message_count, provider, model, workspace_path',
        'search_cols': ['title', 'id'],
        'label': 'conversation sessions',
    },
    'messages': {
        'table': 'messages',
        'fts': 'messages_fts',
        'columns': 'id, session_id, role, content, created_at',
        'search_cols': ['content'],
        'label': 'chat messages',
    },
    'timeline': {
        'table': 'episodic_timeline',
        'fts': None,
        'columns': 'id, timestamp, session_id, event_summary, category',
        'search_cols': ['event_summary', 'category', 'session_id'],
        'label': 'episodic timeline entries',
    },
    'blackboard': {
        'table': 'blackboard',
        'fts': None,
        'columns': 'id, session_id, agent, key, value, priority, created_at, expires_at',
        'search_cols': ['agent', 'key', 'value'],
        'label': 'inter-agent blackboard notes',
    },
    'exams': {
        'table': 'exams',
        'fts': None,
        'columns': 'id, title, topic, created_at, source, source_files',
        'search_cols': ['title', 'topic'],
        'label': 'exam sessions',
    },
    'examAttempts': {
        'table': 'exam_attempts',
        'fts': None,
        'columns': 'id, exam_id, question_id, selected_index, is_correct, asked_for_help, answered_at',
        'search_cols': ['exam_id'],
        'label': 'exam attempt history',
    },
}

# Snake_case / alternate names → canonical store key (models often use SQL names).
_STORE_ALIASES: dict[str, str] = {
    'auto_memories': 'autoMemories',
    'auto-memories': 'autoMemories',
    'exam_attempts': 'examAttempts',
    'exam-attempts': 'examAttempts',
    'learned_heuristics': 'heuristics',
    'semantic_facts': 'facts',
    'kv': 'memory',
    'memory_store': 'memory',
}


def _resolve_store(store: str) -> str:
    """Map wire/SQL aliases to a canonical ``_BRAINStores`` key."""
    if store in _BRAINStores:
        return store
    if store in _STORE_ALIASES:
        return _STORE_ALIASES[store]
    # camelCase ↔ snake_case soft match
    snake = ''.join((('_' + c.lower()) if c.isupper() else c) for c in store)
    if snake in _STORE_ALIASES:
        return _STORE_ALIASES[snake]
    if snake in _BRAINStores:
        return snake
    return store


def _brain_query_graph(query: str, filters: dict | None, limit: int) -> str:
    """Read graph entities/relations from SQLite graph_memory (SoT).

    Returns model-friendly rows with ``label`` / ``description`` / ``typeLabel``
    alongside the stable technical ``entity`` / ``source`` / ``target`` ids.
    Falls back to legacy ``august_graph_memory.json`` only if SQLite is empty.
    """
    import json as _json

    lim = max(1, min(int(limit or 10), 100))
    q = (query or '').strip().lower()
    rows: list[dict[str, object]] = []

    try:
        from app.services.memory import graph_memory

        if q:
            entities = graph_memory.searchEntities(query)[:lim]
        else:
            entities = graph_memory.listEntities(lim)

        name_to_meta: dict[str, dict[str, object]] = {}
        keys: list[str] = []
        for ent in entities:
            if not isinstance(ent, dict):
                continue
            name = as_str(ent.get('name'), '')
            if not name:
                continue
            meta_raw = ent.get('metadata')
            meta: dict[str, object] = dict(meta_raw) if isinstance(meta_raw, dict) else {}
            etype = as_str(ent.get('type'), 'general') or 'general'
            label = graph_memory.humanize_entity_label(name, meta)
            description = graph_memory.entity_description(name, meta)
            # Text filter against both technical id and human label/description.
            if q:
                hay = ' '.join([name, label, description, etype, as_str(meta.get('preview'), '')]).lower()
                if q not in hay:
                    continue
            name_to_meta[name] = meta
            keys.append(graph_memory.entityKey(name))
            rows.append(
                {
                    'entity': name,
                    'label': label,
                    'type': etype,
                    'typeLabel': graph_memory.humanize_entity_type(etype),
                    'description': description,
                    'attributes': meta,
                }
            )
            if len(rows) >= lim:
                break

        if keys and len(rows) < lim:
            for rel in graph_memory.listRelationsForKeys(keys, limit=min(200, lim * 4)):
                if not isinstance(rel, dict):
                    continue
                source = as_str(rel.get('source'), '')
                target = as_str(rel.get('target'), '')
                relation = as_str(rel.get('type'), 'related') or 'related'
                if not source or not target:
                    continue
                src_label = graph_memory.humanize_entity_label(source, name_to_meta.get(source))
                tgt_label = graph_memory.humanize_entity_label(target, name_to_meta.get(target))
                rel_label = graph_memory.humanize_relation_type(relation)
                if q:
                    hay = ' '.join([source, target, relation, src_label, tgt_label, rel_label]).lower()
                    if q not in hay:
                        continue
                rows.append(
                    {
                        'source': source,
                        'sourceLabel': src_label,
                        'relation': relation,
                        'relationLabel': rel_label,
                        'target': target,
                        'targetLabel': tgt_label,
                    }
                )
                if len(rows) >= lim:
                    break

        if rows:
            return _json.dumps(rows[:lim], ensure_ascii=False)
    except Exception:
        rows = []

    # Legacy JSON fallback for older installs that never migrated to SQLite.
    try:
        import os as _os
        from pathlib import Path
        from app.lib.paths import dataPath

        candidates: list[Path] = []
        env = _os.environ.get('AUGUST_GRAPH_MEMORY_FILE')
        if env:
            candidates.append(Path(env))
        candidates.append(dataPath('august_graph_memory.json'))
        candidates.extend(
            [
                Path('data') / 'august_graph_memory.json',
                Path('august_graph_memory.json'),
                Path(_os.path.expanduser('~/.august/august_graph_memory.json')),
            ]
        )
        graphPath = next((p for p in candidates if p.exists()), None)
        if graphPath is None:
            return _json.dumps([])
        with open(graphPath, 'r', encoding='utf-8') as f:
            data = _json.load(f)
    except Exception:
        return _json.dumps([])

    legacy: list[dict[str, object]] = []
    entities = data.get('entities', []) if isinstance(data, dict) else []
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = as_str(ent.get('name'), '')
        if q and q not in name.lower():
            continue
        try:
            from app.services.memory import graph_memory

            attrs_raw = ent.get('attributes')
            attrs: dict[str, object] = dict(attrs_raw) if isinstance(attrs_raw, dict) else {}
            label = graph_memory.humanize_entity_label(name, attrs)
            etype = as_str(ent.get('type'), '')
            legacy.append(
                {
                    'entity': name,
                    'label': label,
                    'type': etype,
                    'typeLabel': graph_memory.humanize_entity_type(etype),
                    'description': '',
                    'attributes': ent.get('attributes', {}),
                }
            )
        except Exception:
            legacy.append({'entity': name, 'type': ent.get('type', ''), 'attributes': ent.get('attributes', {})})
        if len(legacy) >= lim:
            return _json.dumps(legacy[:lim], ensure_ascii=False)
    if len(legacy) < lim:
        relations = data.get('relations', []) if isinstance(data, dict) else []
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            source = as_str(rel.get('source'), '')
            target = as_str(rel.get('target'), '')
            if q and q not in (source + target).lower():
                continue
            relation = as_str(rel.get('relation'), 'related')
            try:
                from app.services.memory import graph_memory

                legacy.append(
                    {
                        'source': source,
                        'sourceLabel': graph_memory.humanize_entity_label(source),
                        'relation': relation,
                        'relationLabel': graph_memory.humanize_relation_type(relation),
                        'target': target,
                        'targetLabel': graph_memory.humanize_entity_label(target),
                    }
                )
            except Exception:
                legacy.append({'source': source, 'relation': relation, 'target': target})
            if len(legacy) >= lim:
                break
    return _json.dumps(legacy[:lim], ensure_ascii=False)


def _brain_query_daemons(query: str, filters: dict | None, limit: int) -> str:
    """v1.1: Read live daemon registry (Phase 8).

    Returns list of {sessionId, name, status, watchCondition, lastCheck, error} rows.
    If no daemons are running, returns an empty list.
    Gracefully degrades if daemon_manager is unavailable (returns []).
    """
    import json as _json

    try:
        from app.services import daemon_manager
    except ImportError:
        return _json.dumps([])
    try:
        internal = getattr(daemon_manager, '_daemons', None)
        if not isinstance(internal, dict):
            return _json.dumps([])
        rows: list[dict] = []
        for sessionId, daemons in internal.items():
            for d in daemons or []:
                if hasattr(d, '__dict__'):
                    info = dict(d.__dict__)
                elif isinstance(d, dict):
                    info = d
                else:
                    continue
                row = {
                    'sessionId': sessionId,
                    'name': info.get('name', ''),
                    'status': info.get('status', 'unknown'),
                    'watchCondition': info.get('watch_condition'),
                    'lastCheck': info.get('last_check'),
                    'error': info.get('error'),
                }
                if filters and filters.get('sessionId') and (filters['sessionId'] != sessionId):
                    continue
                if query and query.lower() not in row['name'].lower():
                    continue
                rows.append(row)
                if len(rows) >= limit:
                    break
            if len(rows) >= limit:
                break
        return _json.dumps(rows[:limit], ensure_ascii=False)
    except Exception:
        return _json.dumps([])


def brain_query(store: str, query: str = '', filters: dict | None = None, limit: int = 10) -> str:
    """Read-only query across any brain store (§11 of the cognitive spec).

    Returns compact JSON rows. Capped at ``limit`` and at a hard token
    ceiling (truncated with "N more rows; narrow your query" if exceeded).

    Unknown or not-yet-shipped stores return a structured error string
    rather than raising — keeps the tool stable across phases.

    Accepts canonical wire names (``autoMemories``) and common aliases
    (``auto_memories``, SQL-ish names).
    """
    _TOKENCeiling = 2000
    conn = _conn()
    if store in ('graph',):
        return _brain_query_graph(query, filters, limit)
    if store in ('daemons',):
        return _brain_query_daemons(query, filters, limit)
    store = _resolve_store(store)
    if store not in _BRAINStores:
        available = sorted(set(list(_BRAINStores.keys()) + list(_STORE_ALIASES.keys()) + ['graph', 'daemons']))
        return json.dumps(
            {'error': f"store '{store}' not available in this build", 'available': available}
        )
    info = _BRAINStores[store]
    try:
        tableCheck = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (info['table'],)
        ).fetchone()
        if not tableCheck:
            return json.dumps({'error': f"store '{store}' table not yet created"})
        cols = as_str(info['columns'])
        sql = f'SELECT {cols} FROM {info["table"]}'
        params: list[object] = []
        whereClauses: list[str] = []
        if query:
            fts = info.get('fts')
            if fts:
                ftsQ = _fts_match_query(query)
                if ftsQ:
                    qualifiedCols = ', '.join((f't.{c.strip()}' for c in cols.split(',')))
                    # Table-level MATCH must use the FTS table name (not alias alone).
                    # Column-level fts.content is wrong for memory_store_fts (key,value).
                    sql = (
                        f'SELECT {qualifiedCols} FROM {fts} AS fts '
                        f'JOIN {info["table"]} AS t ON fts.rowid = t.rowid '
                        f'WHERE {fts} MATCH ? ORDER BY rank'
                    )
                    params = [ftsQ]
                else:
                    whereClauses.append('1=0')
            else:
                searchParts = []
                for col in as_list(info['search_cols']):
                    searchParts.append(f'{col} LIKE ?')
                    params.append(f'%{query}%')
                whereClauses.append(f'({" OR ".join(searchParts)})')
        if filters:
            # Accept camelCase filter keys (wire) by converting to snake for columns
            colInfo = conn.execute(f'PRAGMA table_info({info["table"]})').fetchall()
            colNames = {c['name'] for c in colInfo}
            for key, val in filters.items():
                snake_key = key
                if key not in colNames:
                    converted = camelToSnake({key: val})
                    if isinstance(converted, dict) and converted:
                        snake_key = next(iter(converted.keys()))
                if snake_key in colNames:
                    whereClauses.append(f'{snake_key} = ?')
                    params.append(val)
        if whereClauses:
            if 'WHERE' not in sql and 'MATCH' not in sql:
                sql += ' WHERE ' + ' AND '.join(whereClauses)
            elif 'MATCH' in sql and 'WHERE' in sql:
                pass
            elif 'MATCH' not in sql:
                sql += ' WHERE ' + ' AND '.join(whereClauses)
        sql += f' LIMIT {min(limit, 100)}'
        rows = conn.execute(sql, params).fetchall()
        results = [_row_as_wire(r) for r in rows]
        if store == 'autoMemories':
            try:
                from app.services.memory.auto_memory import enrich_memory_for_model

                results = [enrich_memory_for_model(r) if isinstance(r, dict) else r for r in results]
            except Exception:
                pass
        resultJson = json.dumps(results, default=str, ensure_ascii=False)
        if len(resultJson) > _TOKENCeiling * 4:
            truncated: list[dict[str, object]] = []
            charBudget = _TOKENCeiling * 4
            for r in results:
                rowS = json.dumps(r, default=str, ensure_ascii=False)
                if len(json.dumps(truncated, default=str, ensure_ascii=False)) + len(rowS) < charBudget:
                    truncated.append(r)
                else:
                    break
            nMore = len(results) - len(truncated)
            resultJson = json.dumps(
                {'rows': truncated, 'note': f'{nMore} more rows; narrow your query'}, default=str, ensure_ascii=False
            )
        return resultJson
    except Exception as exc:
        return json.dumps({'error': f'brain_query({store}): {exc}'})


