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
        'fts': None,
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


def _brain_query_graph(query: str, filters: dict | None, limit: int) -> str:
    """v1.1: Read graph entities/relations from august_graph_memory.json.

    Returns list of {entity, type, attributes} or {source, relation, target} rows.
    If the JSON file is missing or empty, returns an empty list (NOT an error).
    """
    try:
        import json as _json
        import os as _os

        candidates = [
            _os.path.join('data', 'august_graph_memory.json'),
            'august_graph_memory.json',
            _os.path.expanduser('~/.august/august_graph_memory.json'),
        ]
        graphPath = next((p for p in candidates if _os.path.exists(p)), None)
        if graphPath is None:
            return _json.dumps([])
        with open(graphPath, 'r', encoding='utf-8') as f:
            data = _json.load(f)
    except (ImportError, _json.JSONDecodeError, OSError):
        return _json.dumps([])
    rows: list[dict] = []
    entities = data.get('entities', []) if isinstance(data, dict) else []
    for ent in entities:
        if not isinstance(ent, dict):
            continue
        name = ent.get('name', '')
        if query and query.lower() not in name.lower():
            continue
        rows.append({'entity': name, 'type': ent.get('type', ''), 'attributes': ent.get('attributes', {})})
        if len(rows) >= limit:
            return _json.dumps(rows[:limit], ensure_ascii=False)
    if len(rows) < limit:
        relations = data.get('relations', []) if isinstance(data, dict) else []
        for rel in relations:
            if not isinstance(rel, dict):
                continue
            source = rel.get('source', '')
            target = rel.get('target', '')
            if query and query.lower() not in (source + target).lower():
                continue
            rows.append({'source': source, 'relation': rel.get('relation', ''), 'target': target})
            if len(rows) >= limit:
                break
    return _json.dumps(rows[:limit], ensure_ascii=False)


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
    """
    _TOKENCeiling = 2000
    conn = _conn()
    if store == 'graph':
        return _brain_query_graph(query, filters, limit)
    if store == 'daemons':
        return _brain_query_daemons(query, filters, limit)
    if store not in _BRAINStores:
        return json.dumps(
            {'error': f"store '{store}' not available in this build", 'available': sorted(_BRAINStores.keys())}
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


