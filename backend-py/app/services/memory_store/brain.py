"""brain_query tool domain (multi-store FTS/SQL)."""
from __future__ import annotations

import json

from app.adapters.case_converters import camelToSnake
from app.json_narrowing import as_list, as_str
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
    'heuristics': {
        'table': 'learned_heuristics',
        'fts': None,
        'columns': 'id, rule, source, category, created_at, updated_at',
        'search_cols': ['rule', 'source'],
        'label': 'legacy learned rules (no live writer — deletable)',
    },
    'facts': {
        'table': 'facts',
        'fts': None,
        'columns': (
            'id, fact_key, fact_value, title, kind, category, source, confidence, '
            'use_count, last_used_at, status, expires_at, created_at, updated_at'
        ),
        'search_cols': ['fact_key', 'fact_value', 'title'],
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
    'exam_attempts': 'examAttempts',
    'exam-attempts': 'examAttempts',
    'learned_heuristics': 'heuristics',
    'semantic_facts': 'facts',
    'kv': 'memory',
    'memory_store': 'memory',
}

# Virtual (non-table) stores handled by dedicated query fns.
_VIRTUAL_STORES = frozenset({'failure-fingerprints'})
_STORE_ALIASES.update(
    {
        'failure_fingerprints': 'failure-fingerprints',
        'failureFingerprints': 'failure-fingerprints',
    }
)


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


def _brain_query_project_memory(query: str, filters: dict | None, limit: int) -> str:
    """Part 17 Phase A: the project-memory store (virtual, md-file backed).

    Rows = {file, title, body, updated} from the current session's
    workspace ``<ws>/.aug/memory/*.md``, BM25-ranked for a query (fallback:
    file order). Workspace comes from the calling session via the
    ContextVar; ``filters={'workspace': …}`` overrides for admin surfaces.
    """
    import json as _json

    ws = ''
    if filters and isinstance(filters.get('workspace'), str) and filters['workspace'].strip():
        ws = str(filters['workspace']).strip()
    if not ws:
        try:
            from app.services.workbench import workbench as _wb
            from app.services.workbench.context import currentSessionId

            sid = str(currentSessionId.get() or '')
            session = _wb.getWorkbenchSession(sid) if sid else None
            if session is not None:
                ws = str(getattr(session, 'workspacePath', '') or '')
        except Exception:
            ws = ''
    if not ws:
        return _json.dumps(
            {'error': 'project-memory requires a workspace (no workspacePath on this session)'}
        )
    try:
        from app.services import project_memory as _pm

        if query:
            entries = _pm.search_entries(ws, query, k=limit)
        else:
            entries = _pm.read_entries(ws)[: max(1, limit)]
        rows = [
            {
                'file': e.file,
                'title': e.title,
                'body': e.body,
                'updated': e.updated,
            }
            for e in entries
        ]
        return _json.dumps(rows, ensure_ascii=False)
    except Exception as exc:
        return _json.dumps({'error': f'project-memory query failed: {exc}'})


def _brain_query_fingerprints(query: str, filters: dict | None, limit: int) -> str:
    """Part 16 Phase B: failure fingerprints as a virtual brain_query store.

    Fingerprints are the workflow-grain recurrence evidence — querying them
    via ``brain_query store=failure-fingerprints`` makes them model-visible
    without touching the ``search`` tool (the "search memory section" add
    is CUT — brain_query already IS the memory search tool). Query matches
    against the signature text; rows rank by episode_count (recurrence)
    then recency.
    """
    import json as _json

    conn = _conn()
    sql = 'SELECT * FROM failure_fingerprints'
    params: list[object] = []
    where: list[str] = []
    q = (query or '').strip()
    if q:
        where.append('(fingerprint LIKE ? OR status LIKE ?)')
        params.extend([f'%{q}%', f'%{q}%'])
    if filters and isinstance(filters.get('status'), str) and filters['status'].strip():
        where.append('status = ?')
        params.append(str(filters['status']).strip())
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY episode_count DESC, last_seen DESC'
    cap = max(1, min(limit, 100))
    sql += f' LIMIT {cap}'
    try:
        rows = [_row_as_wire(r) for r in conn.execute(sql, params).fetchall()]
        return _json.dumps(rows, default=str, ensure_ascii=False)
    except Exception as exc:
        return _json.dumps({'error': f'failure-fingerprints query failed: {exc}'})


def _brain_query_facts_ranked(query: str, filters: dict | None, limit: int) -> str:
    """Phase D: BM25-ranked facts retrieval for ``brain_query``.

    Mirrors the tail block's ranking (``fact_retrieval`` — one shared
    implementation) instead of LIKE-in-rowid-order. An exact ``fact_key``
    hit short-circuits to the direct row. Returns the same wire shape as
    the generic path (camelCase rows) so callers see no difference.
    """
    q = (query or '').strip()
    cap = max(1, min(limit, 100))
    # Exact-key fast path: a point query must not depend on tokenization.
    conn = _conn()
    exact = conn.execute(
        'SELECT * FROM facts WHERE fact_key = ?', (q,)
    ).fetchone()
    if exact is not None:
        return json.dumps([_row_as_wire(exact)], default=str, ensure_ascii=False)
    try:
        from app.services.memory_store.fact_retrieval import retrieve_relevant_facts

        facts = retrieve_relevant_facts(q, k=cap)
    except Exception as exc:
        return json.dumps({'error': f'brain_query(facts): ranked retrieval failed: {exc}'})
    if not facts:
        # No BM25 hits — fall through to the old LIKE scan so partial
        # tokens and punctuation-heavy queries still find their rows.
        return ''
    # Enrich the compact ranking rows with the full wire columns the
    # generic path returns (join back by key, one IN query).
    keys = [str(f.get('key') or '') for f in facts]
    placeholders = ','.join('?' * len(keys))
    rows = conn.execute(
        f'SELECT * FROM facts WHERE fact_key IN ({placeholders})', keys
    ).fetchall()
    byKey = {str(r['fact_key']): r for r in rows}
    ordered = [byKey[k] for k in keys if k in byKey]
    results = [_row_as_wire(r) for r in ordered]
    # Filters apply after ranking (status/category equality on wire keys).
    if filters:
        import re as _re

        def _match(row: dict[str, object]) -> bool:
            for fk, fv in filters.items():
                snake = _re.sub(r'(?<!^)(?=[A-Z])', '_', str(fk)).lower()
                for cand in (fk, snake):
                    if cand in row and str(row[cand]) != str(fv):
                        return False
            return True

        results = [r for r in results if _match(r)]
    resultJson = json.dumps(results, default=str, ensure_ascii=False)
    if len(resultJson) > 2000 * 4:
        wrapped = {
            'rows': results[:10],
            'note': f'{max(0, len(results) - 10)} more rows; narrow your query',
        }
        resultJson = json.dumps(wrapped, default=str, ensure_ascii=False)
    return resultJson


def brain_query(store: str, query: str = '', filters: dict | None = None, limit: int = 10) -> str:
    """Read-only query across any brain store (§11 of the cognitive spec).

    Returns compact JSON rows. Capped at ``limit`` and at a hard token
    ceiling (truncated with "N more rows; narrow your query" if exceeded).

    Unknown or not-yet-shipped stores return a structured error string
    rather than raising — keeps the tool stable across phases.

    Accepts canonical wire names (``examAttempts``) and common aliases
    (``exam_attempts``, SQL-ish names).
    """
    _TOKENCeiling = 2000
    conn = _conn()
    if store in ('daemons',):
        return _brain_query_daemons(query, filters, limit)
    if store in ('project-memory', 'project_memory', 'projectMemory'):
        return _brain_query_project_memory(query, filters, limit)
    store = _resolve_store(store)
    if store in _VIRTUAL_STORES:
        return _brain_query_fingerprints(query, filters, limit)
    if store not in _BRAINStores:
        available = sorted(
            set(list(_BRAINStores.keys()) + list(_STORE_ALIASES.keys()) + ['daemons'] + list(_VIRTUAL_STORES))
        )
        return json.dumps(
            {'error': f"store '{store}' not available in this build", 'available': available}
        )
    info = _BRAINStores[store]
    # Phase D (Part 17): facts queries rank through the BM25 index shared
    # with the tail block — relevance instead of LIKE-in-rowid-order. An
    # exact fact_key match keeps the direct fast path (a key lookup is a
    # point query, not a search). '' = no BM25 hits → generic LIKE scan.
    if store == 'facts' and query:
        ranked = _brain_query_facts_ranked(query, filters, limit)
        if ranked:
            return ranked
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
                        f'WHERE {fts} MATCH ?'
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
            if 'MATCH' in sql:
                # FTS branch: filters append with AND before ORDER BY — the
                # old code dropped them (with their params) here, so every
                # tagged FTS query crashed with a bindings mismatch (audit
                # finding).
                sql += ' AND ' + ' AND '.join(whereClauses) + ' ORDER BY rank'
            elif 'WHERE' in sql:
                sql += ' AND ' + ' AND '.join(whereClauses)
            else:
                sql += ' WHERE ' + ' AND '.join(whereClauses)
        elif 'MATCH' in sql:
            sql += ' ORDER BY rank'
        cap = max(1, min(limit, 100))
        # Count query over the same FROM/WHERE (no select list, no ORDER BY)
        # so a result set that exactly fills ``cap`` can report its total —
        # without this a default-limit listing silently hides further rows.
        count_sql = 'SELECT COUNT(*)' + sql[sql.index(' FROM '):]
        order_at = count_sql.rfind(' ORDER BY ')
        if order_at != -1:
            count_sql = count_sql[:order_at]
        sql += f' LIMIT {cap}'
        rows = conn.execute(sql, params).fetchall()
        total: int | None = None
        if len(rows) >= cap:
            try:
                total = int(conn.execute(count_sql, params).fetchone()[0])
            except Exception:
                total = None
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
            wrapped: dict[str, object] = {
                'rows': truncated,
                'note': f'{nMore} more rows; narrow your query',
            }
            if total is not None and total > len(truncated):
                wrapped['total'] = total
            resultJson = json.dumps(wrapped, default=str, ensure_ascii=False)
        elif total is not None and total > len(results):
            resultJson = json.dumps(
                {
                    'rows': results,
                    'total': total,
                    'note': f'showing first {len(results)} of {total}; raise limit to see all',
                },
                default=str,
                ensure_ascii=False,
            )
        return resultJson
    except Exception as exc:
        return json.dumps({'error': f'brain_query({store}): {exc}'})


def brain_store_summary() -> list[dict[str, object]]:
    """Per-store counts for the settings Memory page (read-only).

    Stores whose table no longer exists (e.g. learned_heuristics after the
    empty-legacy drop) are omitted rather than shown with a phantom zero.
    """
    conn = _conn()
    out: list[dict[str, object]] = []
    for name, info in _BRAINStores.items():
        table = as_str(info['table'])
        try:
            exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1", (table,)
            ).fetchone()
            if exists is None:
                continue
            row = conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()
            count = int(row[0]) if row else 0
        except Exception:
            count = 0  # table not created yet on this install
        out.append({'name': name, 'label': as_str(info.get('label')), 'count': count})
    return out


def brain_browse(
    store: str,
    limit: int = 50,
    offset: int = 0,
    query: str = '',
    *,
    sort: str = '',
    category: str = '',
    source: str = '',
    confidence: str = '',
) -> dict[str, object]:
    """Paginated browse over a brain store for the settings UI.

    Unlike ``brain_query`` (token-capped JSON string for models) this
    returns structured rows + total so a human can page through what
    August stores. Read-only; unknown stores return an error dict.

    Part 17 Phase C: ``sort`` (newest|oldest|updated|confidence) picks the
    ORDER BY; ``category``/``source``/``confidence`` are server-side
    equality filters (gap 3-4) so filtering works past the fetch cap.
    """
    conn = _conn()
    resolved = _resolve_store(store)
    if resolved not in _BRAINStores:
        return {'error': f"store '{store}' not available", 'rows': [], 'total': 0}
    info = _BRAINStores[resolved]
    table = as_str(info['table'])
    cols = as_str(info['columns'])
    lim = max(1, min(int(limit), 200))
    off = max(0, int(offset))
    try:
        tableCheck = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        if not tableCheck:
            return {'store': resolved, 'rows': [], 'total': 0, 'limit': lim, 'offset': off}
        whereParts: list[str] = []
        params: list[object] = []
        q = (query or '').strip()
        if q:
            searchCols = as_list(info['search_cols'])
            if searchCols:
                whereParts.append(' OR '.join(f'{col} LIKE ?' for col in searchCols))
                params.extend([f'%{q}%'] * len(searchCols))
        # Server-side equality filters (only columns the table actually has,
        # so a filter on one store never 500s another).
        colInfo = conn.execute(f'PRAGMA table_info({table})').fetchall()
        colNames = {c['name'] for c in colInfo}
        for key, val in (('category', category), ('source', source), ('confidence', confidence)):
            v = (val or '').strip()
            if not v:
                continue
            if key == 'confidence':
                # §9 F-6: confidence is a REAL column — low/medium/high are
                # range buckets, not equality matches (equality against the
                # word can never hit a number).
                if v not in ('low', 'medium', 'high') or 'confidence' not in colNames:
                    continue  # free-text confidence stays unfiltered, not a 500
                whereParts.append('CAST(confidence AS REAL) < ?' if v == 'low' else
                                  'CAST(confidence AS REAL) >= ? AND CAST(confidence AS REAL) < ?'
                                  if v == 'medium' else 'CAST(confidence AS REAL) >= ?')
                params.extend([0.5] if v == 'low' else [0.5, 0.8] if v == 'medium' else [0.8])
                continue
            if key in colNames:
                whereParts.append(f'{key} = ?')
                params.append(v)
        where = (' WHERE ' + ' AND '.join(f'({p})' for p in whereParts)) if whereParts else ''
        total = int(conn.execute(f'SELECT COUNT(*) FROM {table}{where}', params).fetchone()[0])
        # Sort control (gap 4). Newest/oldest ride the rowid; updated/confidence
        # fall back to rowid when the column is missing on this store.
        order = ' ORDER BY rowid DESC'
        s = (sort or '').strip().lower()
        if s == 'oldest':
            order = ' ORDER BY rowid ASC'
        elif s == 'updated' and 'updated_at' in colNames:
            order = ' ORDER BY updated_at DESC'
        elif s == 'confidence' and 'confidence' in colNames:
            order = ' ORDER BY CAST(confidence AS REAL) DESC'
        rows = conn.execute(
            f'SELECT {cols} FROM {table}{where}{order} LIMIT ? OFFSET ?',
            [*params, lim, off],
        ).fetchall()
        return {
            'store': resolved,
            'label': as_str(info.get('label')),
            'rows': [_row_as_wire(r) for r in rows],
            'total': total,
            'limit': lim,
            'offset': off,
        }
    except Exception as exc:
        return {'error': f'brain_browse({store}): {exc}', 'rows': [], 'total': 0}


def brain_index_snippet() -> str:
    """Compact boot index of durable memory for intake injection (B3).

    Lists the top-15 facts (by ``updated_at``, skipping expired rows) as
    ``fact_key (category)`` plus the last-5 episodic timeline summaries,
    capped near 250 tokens. Injected at intake so the model can pull
    relevant memory by name via ``brain_query`` instead of blind-scanning
    raw tables. Returns '' when there is nothing worth injecting.
    """
    conn = _conn()
    lines: list[str] = []
    try:
        factRows = conn.execute(
            "SELECT fact_key, title, category FROM facts "
            "WHERE (expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday('now')) "
            "AND (status IS NULL OR status = 'active') "
            "ORDER BY updated_at DESC LIMIT 15"
        ).fetchall()
        if factRows:
            lines.append('Facts:')
            for r in factRows:
                label = str(r['title'] or '').strip() or str(r['fact_key'])
                lines.append(f"  {label} ({r['category'] or 'general'})")
    except Exception:
        pass
    try:
        tlRows = conn.execute(
            'SELECT event_summary FROM episodic_timeline ORDER BY timestamp DESC LIMIT 5'
        ).fetchall()
        if tlRows:
            lines.append('Recent events:')
            for r in tlRows:
                summary = str(r['event_summary'] or '').strip()
                if summary:
                    lines.append(f'  {summary[:160]}')
    except Exception:
        pass
    if not lines:
        return ''
    # ~250-token cap ≈ 1000 chars.
    return '\n'.join(lines)[:1000]


# Per-store writable field whitelists for brain_update_row (B5). Stores absent
# here are not inline-editable from the settings UI; heuristics is a legacy
# store with no live writer — rows are deletable (see _ROW_DELETABLE) but not
# editable ("read-only legacy" means no writer, not undeletable; plan §3.3).
_ROW_EDIT_FIELDS: dict[str, frozenset[str]] = {
    'facts': frozenset({'fact_value', 'title', 'kind', 'category', 'confidence', 'expires_at'}),
    'memory': frozenset({'value'}),
    'timeline': frozenset({'event_summary', 'category'}),
}
_ROW_DELETABLE: frozenset[str] = frozenset({'facts', 'memory', 'timeline', 'heuristics'})


def _store_id_column(store: str) -> str:
    """Row identifier for a store: ``key`` for the KV memory store, else ``id``."""
    return 'key' if store == 'memory' else 'id'


def _record_row_rollback(store: str, target: str, before: object, after: object) -> None:
    """Best-effort undo record for a settings-UI memory mutation."""
    try:
        from app.services.rollback_store import record_rollback

        record_rollback(
            type='restore_memory_item',
            target=f'{store}:{target}',
            before=before,
            after=after,
            extra={'store': store},
        )
    except Exception:
        pass


def brain_delete_row(store: str, row_id: object) -> dict[str, object]:
    """Delete one row from a brain store for the settings UI (B5).

    FTS-safe: memory_store carries AFTER DELETE sync triggers;
    facts/timeline/heuristics have no FTS table.
    """
    conn = _conn()
    resolved = _resolve_store(store)
    if resolved not in _ROW_DELETABLE or resolved not in _BRAINStores:
        return {'ok': False, 'error': f"store '{store}' does not support per-entry delete"}
    info = _BRAINStores[resolved]
    table = as_str(info['table'])
    idCol = _store_id_column(resolved)
    try:
        before = conn.execute(f'SELECT * FROM {table} WHERE {idCol} = ?', (row_id,)).fetchone()
        if before is None:
            return {'ok': False, 'error': 'row not found'}
        beforeWire = _row_as_wire(before)
        cursor = conn.execute(f'DELETE FROM {table} WHERE {idCol} = ?', (row_id,))
        conn.commit()
        if cursor.rowcount > 0:
            _record_row_rollback(resolved, str(row_id), beforeWire, None)
        return {'ok': cursor.rowcount > 0, 'store': resolved}
    except Exception as exc:
        return {'ok': False, 'error': f'brain_delete_row({store}): {exc}'}


def brain_update_row(store: str, row_id: object, patch: dict[str, object]) -> dict[str, object]:
    """Update whitelisted fields of one brain-store row for the settings UI (B5).

    Only fields in the per-store whitelist are applied; unknown or read-only
    fields are ignored. heuristics is read-only legacy (403).
    """
    conn = _conn()
    resolved = _resolve_store(store)
    if resolved == 'heuristics':
        return {'ok': False, 'status': 403, 'error': "store 'heuristics' is read-only legacy"}
    allowed = _ROW_EDIT_FIELDS.get(resolved)
    if allowed is None or resolved not in _BRAINStores:
        return {'ok': False, 'error': f"store '{store}' does not support per-entry edit"}
    info = _BRAINStores[resolved]
    table = as_str(info['table'])
    idCol = _store_id_column(resolved)
    try:
        colNames = {c['name'] for c in conn.execute(f'PRAGMA table_info({table})').fetchall()}
        sets: list[str] = []
        params: list[object] = []
        for key, val in (patch or {}).items():
            if key in allowed and key in colNames:
                sets.append(f'{key} = ?')
                params.append(val)
        if not sets:
            return {'ok': False, 'error': 'no writable fields in patch'}
        before = conn.execute(f'SELECT * FROM {table} WHERE {idCol} = ?', (row_id,)).fetchone()
        if before is None:
            return {'ok': False, 'error': 'row not found'}
        beforeWire = _row_as_wire(before)
        # Bump updated_at so edited entries re-sort to the top of recency views.
        if 'updated_at' in colNames and 'updated_at' not in {s.split(' = ')[0] for s in sets}:
            sets.append("updated_at = datetime('now')")
        conn.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE {idCol} = ?", (*params, row_id))
        conn.commit()
        after = conn.execute(f'SELECT * FROM {table} WHERE {idCol} = ?', (row_id,)).fetchone()
        afterWire = _row_as_wire(after) if after is not None else None
        _record_row_rollback(resolved, str(row_id), beforeWire, afterWire)
        return {'ok': True, 'store': resolved, 'row': afterWire}
    except Exception as exc:
        return {'ok': False, 'error': f'brain_update_row({store}): {exc}'}


