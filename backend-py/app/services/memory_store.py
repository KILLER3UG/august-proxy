"""
SQLite memory store — persists conversations, facts, proposals, lifecycle,
and index data. The core persistence layer for the August "brain".

Port of backend/services/memory/sqlite-memory-store.js (1,431 lines).
Uses aiosqlite for async access and a sync sqlite3 fallback.

DB schema/SQL uses **snake_case**. Rows returned to TypedDicts/API are
converted to camelCase via ``_row_as_wire`` (snakeToCamel) so the HTTP wire
format stays unchanged.
"""

from __future__ import annotations
import asyncio
import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import cast
from app.adapters.case_converters import snakeToCamel, camelToSnake
from app.lib.paths import dataPath
from app.services.memory_schema import ensure_schema
from app.type_aliases import (
    JsonValue,
    MemoryEntryDict,
    FactDict,
    ProposalDict,
    SessionRecord,
    MessageDict,
)
from app.json_narrowing import as_str, as_list, as_int

_BRAINFileEnv = 'AUGUST_BRAIN_SQLITE_FILE'
_DEFAULTBrainFile = 'august_brain.sqlite'
_TIMEOUTMs = 10000
_BUSYRetries = 2
_local = threading.local()


def _db_path() -> Path:
    """Resolve the brain SQLite database path."""
    envPath = os.environ.get(_BRAINFileEnv)
    if envPath:
        return Path(envPath)
    return dataPath(_DEFAULTBrainFile)


def _conn() -> sqlite3.Connection:
    """Get a thread-local connection to the brain database."""
    if not hasattr(_local, 'conn') or _local.conn is None:
        dbPath = _db_path()
        dbPath.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(dbPath), timeout=_TIMEOUTMs / 1000)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('PRAGMA busy_timeout=10000')
        conn.execute('PRAGMA foreign_keys=ON')
        _local.conn = conn
    return _local.conn


def close() -> None:
    """Close the thread-local connection."""
    if hasattr(_local, 'conn') and _local.conn is not None:
        try:
            _local.conn.close()
        except Exception:
            pass
        _local.conn = None


def _q(value: object) -> str:
    """Quote a value for SQL (sync helper)."""
    if value is None:
        return 'NULL'
    return f"'{str(value).replace(chr(39), chr(39) + chr(39))}'"


def _json(value: object) -> str:
    """Serialize a value to JSON for storage."""
    return json.dumps(value)


def _row_as_wire(row: sqlite3.Row | dict[str, object] | None) -> dict[str, object]:
    """Convert a SQLite row (snake_case columns) to a camelCase wire dict."""
    if row is None:
        return {}
    raw = dict(row)
    converted = snakeToCamel(cast(JsonValue, raw))
    return cast(dict[str, object], converted) if isinstance(converted, dict) else raw


def _session_field(session: SessionRecord | dict[str, object], camel: str, default: object = None) -> object:
    """Read a session field accepting camelCase wire keys or snake_case."""
    snake = ''.join((('_' + c.lower()) if c.isupper() else c) for c in camel)
    # Prefer explicit dual-get for common keys without full dict convert
    if camel in session and session.get(camel) is not None:
        return session.get(camel)
    if snake in session and session.get(snake) is not None:  # type: ignore[arg-type]
        return session.get(snake)  # type: ignore[arg-type]
    return default


def init() -> None:
    """Create all tables on first use (migrates camel→snake if needed)."""
    ensure_schema(_conn())


def save_memory(key: str, value: JsonValue) -> None:
    """Save a key-value pair to memory."""
    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO memory_store (key, value, updated_at) VALUES (?, ?, datetime('now'))",
        (key, _json(value)),
    )
    conn.commit()


def get_memory(key: str) -> JsonValue | None:
    """Get a value from memory by key."""
    conn = _conn()
    row = conn.execute('SELECT value FROM memory_store WHERE key = ?', (key,)).fetchone()
    if row:
        try:
            return json.loads(row['value'])
        except (json.JSONDecodeError, TypeError):
            return row['value']
    return None


def delete_memory(key: str) -> bool:
    """Delete a memory key. Returns True if it existed."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM memory_store WHERE key = ?', (key,))
    conn.commit()
    return cursor.rowcount > 0


def list_memory(pattern: str = '%') -> list[MemoryEntryDict]:
    """List memory entries with optional key pattern matching."""
    conn = _conn()
    rows = conn.execute(
        'SELECT key, value, updated_at FROM memory_store WHERE key LIKE ? ORDER BY updated_at DESC',
        (pattern,),
    ).fetchall()
    results: list[MemoryEntryDict] = []
    for r in rows:
        try:
            val = json.loads(r['value'])
        except (json.JSONDecodeError, TypeError):
            val = r['value']
        wire = _row_as_wire(r)
        wire['value'] = val
        results.append(cast(MemoryEntryDict, wire))
    return results


def search_memory(query: str) -> list[MemoryEntryDict]:
    """Full-text search across memory keys and values."""
    if not query or not query.strip():
        return []
    conn = _conn()
    try:
        ftsQuery = ' OR '.join((f'"{w}"*' for w in query.strip().split() if w))
        if not ftsQuery:
            return []
        rows = conn.execute(
            'SELECT key, value FROM memory_store_fts WHERE content MATCH ?\n               ORDER BY rank LIMIT 20',
            (ftsQuery,),
        ).fetchall()
        results: list[MemoryEntryDict] = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            results.append(cast(MemoryEntryDict, {'key': r['key'], 'value': val}))
        return results
    except sqlite3.OperationalError:
        likeQuery = f'%{query.strip()}%'
        rows = conn.execute(
            'SELECT key, value FROM memory_store WHERE key LIKE ? OR value LIKE ? LIMIT 20',
            (likeQuery, likeQuery),
        ).fetchall()
        results = []
        for r in rows:
            try:
                val = json.loads(r['value'])
            except (json.JSONDecodeError, TypeError):
                val = r['value']
            results.append(cast(MemoryEntryDict, {'key': r['key'], 'value': val}))
        return results


def save_fact(
    factKey: str, factValue: JsonValue, category: str = 'general', source: str = '', confidence: float = 1.0
) -> None:
    """Save a structured fact."""
    conn = _conn()
    conn.execute(
        "INSERT OR REPLACE INTO facts (fact_key, fact_value, category, source, confidence, updated_at)\n           VALUES (?, ?, ?, ?, ?, datetime('now'))",
        (factKey, _json(factValue), category, source, confidence),
    )
    conn.commit()


def get_fact(factKey: str) -> FactDict | None:
    """Get a fact by key."""
    conn = _conn()
    row = conn.execute('SELECT * FROM facts WHERE fact_key = ?', (factKey,)).fetchone()
    if not row:
        return None
    return cast(FactDict, _row_as_wire(row))


def search_facts(query: str, category: str = '') -> list[FactDict]:
    """Search facts by key or value."""
    conn = _conn()
    like = f'%{query}%'
    if category:
        rows = conn.execute(
            'SELECT * FROM facts WHERE (fact_key LIKE ? OR fact_value LIKE ?) AND category = ? ORDER BY updated_at DESC LIMIT 20',
            (like, like, category),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM facts WHERE fact_key LIKE ? OR fact_value LIKE ? ORDER BY updated_at DESC LIMIT 20',
            (like, like),
        ).fetchall()
    return [cast(FactDict, _row_as_wire(r)) for r in rows]


def list_facts(category: str = '') -> list[FactDict]:
    """List facts, optionally filtered by category."""
    conn = _conn()
    if category:
        rows = conn.execute(
            'SELECT * FROM facts WHERE category = ? ORDER BY updated_at DESC', (category,)
        ).fetchall()
    else:
        rows = conn.execute('SELECT * FROM facts ORDER BY updated_at DESC').fetchall()
    return [cast(FactDict, _row_as_wire(r)) for r in rows]


def delete_fact(factKey: str) -> bool:
    """Delete a fact by key."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM facts WHERE fact_key = ?', (factKey,))
    conn.commit()
    return cursor.rowcount > 0


def save_proposal(sessionId: str, proposalType: str, content: JsonValue) -> int:
    """Save a proposal (plan, mutation, etc.)."""
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO proposals (session_id, proposal_type, content) VALUES (?, ?, ?)',
        (sessionId, proposalType, _json(content)),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def get_proposal(proposalId: int) -> ProposalDict | None:
    """Get a proposal by ID."""
    conn = _conn()
    row = conn.execute('SELECT * FROM proposals WHERE id = ?', (proposalId,)).fetchone()
    return cast(ProposalDict, _row_as_wire(row)) if row else None


def list_proposals(sessionId: str, status: str = '') -> list[ProposalDict]:
    """List proposals for a session, optionally filtered by status."""
    conn = _conn()
    if status:
        rows = conn.execute(
            'SELECT * FROM proposals WHERE session_id = ? AND status = ? ORDER BY created_at DESC',
            (sessionId, status),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM proposals WHERE session_id = ? ORDER BY created_at DESC', (sessionId,)
        ).fetchall()
    return [cast(ProposalDict, _row_as_wire(r)) for r in rows]


def decide_proposal(proposalId: int, status: str, decidedBy: str = '') -> bool:
    """Decide (approve/reject) a proposal."""
    conn = _conn()
    cursor = conn.execute(
        "UPDATE proposals SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE id = ?",
        (status, decidedBy, proposalId),
    )
    conn.commit()
    return cursor.rowcount > 0


def record_lifecycle(sessionId: str, eventType: str, detail: JsonValue = None) -> int:
    """Record a lifecycle event."""
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO lifecycle (session_id, event_type, detail) VALUES (?, ?, ?)',
        (sessionId, eventType, _json(detail) if detail else None),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def list_lifecycle(sessionId: str, eventType: str = '', limit: int = 100) -> list[dict[str, object]]:
    """List lifecycle events for a session."""
    conn = _conn()
    if eventType:
        rows = conn.execute(
            'SELECT * FROM lifecycle WHERE session_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?',
            (sessionId, eventType, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM lifecycle WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
            (sessionId, limit),
        ).fetchall()
    return [_row_as_wire(r) for r in rows]


def record_config_audit(
    category: str, action: str, actor: str = '', before: JsonValue = None, after: JsonValue = None
) -> int:
    """Record a structured config-change audit entry.

    Used by alias, fallback, and agent mutation paths so that every
    self-configuration change is traceable.
    """
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO config_audit (category, action, actor, before_json, after_json) VALUES (?, ?, ?, ?, ?)',
        (
            category,
            action,
            actor,
            _json(before) if before is not None else None,
            _json(after) if after is not None else None,
        ),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def list_config_audit(category: str = '', limit: int = 200) -> list[dict[str, object]]:
    """List config-change audit entries, newest first."""
    conn = _conn()
    if category:
        rows = conn.execute(
            'SELECT * FROM config_audit WHERE category = ? ORDER BY created_at DESC LIMIT ?',
            (category, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            'SELECT * FROM config_audit ORDER BY created_at DESC LIMIT ?', (limit,)
        ).fetchall()
    results = []
    for r in rows:
        entry: dict[str, object] = {
            'id': r['id'],
            'category': r['category'],
            'action': r['action'],
            'actor': r['actor'] or '',
            'createdAt': r['created_at'],
        }
        for rawKey, outKey in (('before_json', 'before'), ('after_json', 'after')):
            raw = r[rawKey]
            if isinstance(raw, str):
                try:
                    entry[outKey] = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    entry[outKey] = raw
            else:
                entry[outKey] = raw
        results.append(entry)
    return results


def index_session_topic(
    sessionId: str, topic: str, parentTopic: str | None = None, confidence: float = 0.75
) -> bool:
    """Record or update the topic for a session."""
    conn = _conn()
    try:
        conn.execute(
            "INSERT INTO session_topics (session_id, topic, parent_topic, confidence, classified_at)\n               VALUES (?, ?, ?, ?, datetime('now'))\n               ON CONFLICT(session_id) DO UPDATE SET\n                   topic=excluded.topic,\n                   parent_topic=excluded.parent_topic,\n                   confidence=excluded.confidence,\n                   classified_at=excluded.classified_at",
            (sessionId, topic, parentTopic, confidence),
        )
        conn.commit()
        return True
    except Exception:
        return False


def get_session_topic(sessionId: str) -> dict[str, object] | None:
    """Get the classified topic for a session."""
    conn = _conn()
    row = conn.execute('SELECT * FROM session_topics WHERE session_id = ?', (sessionId,)).fetchone()
    return _row_as_wire(row) if row else None


def list_topics(limit: int = 50) -> list[dict[str, object]]:
    """List all classified session topics, most recent first."""
    conn = _conn()
    rows = conn.execute(
        'SELECT * FROM session_topics ORDER BY classified_at DESC LIMIT ?', (limit,)
    ).fetchall()
    return [_row_as_wire(r) for r in rows]


def search_sessions_by_topic(topic: str) -> list[dict[str, object]]:
    """Find sessions with a given topic classification."""
    conn = _conn()
    rows = conn.execute(
        'SELECT * FROM session_topics WHERE topic = ? ORDER BY classified_at DESC', (topic,)
    ).fetchall()
    return [_row_as_wire(r) for r in rows]


def save_session(session: SessionRecord) -> None:
    """Persist a session record. Accepts camelCase wire keys (or snake_case)."""
    conn = _conn()
    # Dual-read: wire camelCase or snake_case
    sid = as_str(session.get('id'), '')
    title = _session_field(session, 'title', '')
    started_at = _session_field(session, 'startedAt')
    message_count = _session_field(session, 'messageCount', 0)
    provider = _session_field(session, 'provider', '')
    model = _session_field(session, 'model', '')
    folder_id = _session_field(session, 'folderId')
    is_archived = _session_field(session, 'isArchived')
    workspace_path = _session_field(session, 'workspacePath')
    conn.execute(
        'INSERT OR REPLACE INTO sessions (id, title, started_at, message_count, provider, model, folder_id, is_archived, workspace_path)\n           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (
            sid,
            title or '',
            started_at,
            message_count if message_count is not None else 0,
            provider or '',
            model or '',
            folder_id,
            1 if is_archived else 0,
            workspace_path,
        ),
    )
    conn.commit()


def list_sessions() -> list[SessionRecord]:
    """List all sessions, most recent first."""
    conn = _conn()
    rows = conn.execute('SELECT * FROM sessions ORDER BY started_at DESC').fetchall()
    return [cast(SessionRecord, _row_as_wire(r)) for r in rows]


def get_session(sessionId: str) -> SessionRecord | None:
    """Get a single session by ID."""
    conn = _conn()
    row = conn.execute('SELECT * FROM sessions WHERE id = ?', (sessionId,)).fetchone()
    return cast(SessionRecord, _row_as_wire(row)) if row else None


def delete_session_record(sessionId: str) -> bool:
    """Delete a session record."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM sessions WHERE id = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount > 0


def save_message(sessionId: str, role: str, content: JsonValue) -> int:
    """Save a message to a session."""
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
        (sessionId, role, _json(content)),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def get_messages(sessionId: str) -> list[MessageDict]:
    """Get all messages for a session."""
    conn = _conn()
    rows = conn.execute(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at', (sessionId,)
    ).fetchall()
    results: list[MessageDict] = []
    for r in rows:
        msg = cast(MessageDict, _row_as_wire(r))
        try:
            msg['content'] = json.loads(msg['content']) if isinstance(msg['content'], str) else msg['content']
        except (json.JSONDecodeError, TypeError):
            pass
        results.append(msg)
    return results


def delete_session_messages(sessionId: str) -> int:
    """Delete all messages for a session."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM messages WHERE session_id = ?', (sessionId,))
    conn.commit()
    return cursor.rowcount


def record_usage(
    sessionId: str, model: str, inputTokens: int = 0, outputTokens: int = 0, contextTokens: int = 0
) -> int:
    """Record a usage event.

    ``contextTokens`` captures the provider-reported ``inputTokens`` of the
    FINAL sub-call in the agentic turn — i.e. the true current context fill
    (system prompt + tools + messages, counted once). The cumulative
    ``inputTokens``/``outputTokens`` are still recorded for Usage-page totals.
    """
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO usage_events (session_id, model, input_tokens, output_tokens, context_tokens) VALUES (?, ?, ?, ?, ?)',
        (sessionId, model, inputTokens, outputTokens, contextTokens),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def get_usage(sessionId: str) -> dict[str, object]:
    """Get aggregated usage for a session.

    Returns cumulative totals (for the Usage page) plus ``latestContextTokens``
    — the ``contextTokens`` of the most recent usage event, which equals the
    provider-reported inputTokens of the final sub-call of the latest turn
    (the true current context fill). Also returns the per-event list ordered
    newest-first so the caller can derive the same value independently.
    """
    conn = _conn()
    row = conn.execute(
        'SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, COUNT(*) as request_count FROM usage_events WHERE session_id = ?',
        (sessionId,),
    ).fetchone()
    totals = dict(row) if row else {'total_input': 0, 'total_output': 0, 'request_count': 0}
    latest = conn.execute(
        'SELECT context_tokens, input_tokens FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
        (sessionId,),
    ).fetchone()
    if latest:
        latestCtx = latest['context_tokens'] or latest['input_tokens']
    else:
        latestCtx = 0
    events = [
        {
            'id': e['id'],
            'model': e['model'],
            'inputTokens': e['input_tokens'],
            'outputTokens': e['output_tokens'],
            'contextTokens': e['context_tokens'] or e['input_tokens'],
            'totalTokens': (e['input_tokens'] or 0) + (e['output_tokens'] or 0),
            'createdAt': e['created_at'],
        }
        for e in conn.execute(
            'SELECT id, model, input_tokens, output_tokens, context_tokens, created_at FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC',
            (sessionId,),
        ).fetchall()
    ]
    return {
        'sessionId': sessionId,
        'totalEvents': totals.get('request_count', 0) or 0,
        'totalInputTokens': totals.get('total_input', 0) or 0,
        'totalOutputTokens': totals.get('total_output', 0) or 0,
        'totalTokens': (totals.get('total_input', 0) or 0) + (totals.get('total_output', 0) or 0),
        'totalCost': 0.0,
        'model': events[0]['model'] if events else None,
        'provider': None,
        'contextTokens': latestCtx,
        'latestContextTokens': latestCtx,
        'events': events,
    }


def vacuum() -> None:
    """Vacuum the database to reclaim space."""
    conn = _conn()
    conn.execute('VACUUM')
    conn.commit()


def get_stats() -> dict[str, object]:
    """Get database statistics.

    Keys are camelCase table aliases for wire compatibility (e.g. memoryStore).
    """
    conn = _conn()
    # SQL table → wire key
    tables = [
        ('memory_store', 'memoryStore'),
        ('facts', 'facts'),
        ('proposals', 'proposals'),
        ('sessions', 'sessions'),
        ('messages', 'messages'),
        ('usage_events', 'usageEvents'),
        ('session_topics', 'sessionTopics'),
    ]
    stats: dict[str, object] = {}
    for table, wire_key in tables:
        try:
            row = conn.execute(f'SELECT COUNT(*) as count FROM {table}').fetchone()
            stats[wire_key] = row['count'] if row else 0
        except Exception:
            stats[wire_key] = 0
    stats['db_size_bytes'] = _db_path().stat().st_size if _db_path().exists() else 0
    return stats


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
                ftsQ = ' OR '.join((f'"{w}"*' for w in query.strip().split() if w))
                if ftsQ:
                    qualifiedCols = ', '.join((f't.{c.strip()}' for c in cols.split(',')))
                    sql = f'SELECT {qualifiedCols} FROM {fts} fts JOIN {info["table"]} t ON fts.rowid = t.rowid WHERE fts.content MATCH ? ORDER BY rank'
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


def write_timeline_event(sessionId: str, eventSummary: str, category: str = 'general') -> int:
    """v2: Append an entry to episodic_timeline. Returns the new row's id."""
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO episodic_timeline (timestamp, session_id, event_summary, category) VALUES (datetime('now'), ?, ?, ?)",
        (sessionId, eventSummary, category),
    )
    conn.commit()
    return as_int(cur.lastrowid)


def timeline_sweep() -> int:
    """v2: Hourly sweep. For sessions with no timeline entry, generate one.

    Returns the number of new entries created.
    """
    conn = _conn()
    rows = conn.execute(
        '\n        SELECT s.id FROM sessions s\n        LEFT JOIN episodic_timeline t ON t.session_id = s.id\n        WHERE t.id IS NULL\n        LIMIT 20\n    '
    ).fetchall()
    if not rows:
        return 0
    count = 0
    for r in rows:
        sid = r['id']
        msgs = conn.execute(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 10', (sid,)
        ).fetchall()
        if not msgs:
            continue
        try:
            from app.services.workbench import model_fleet
            from app.providers import resolver as providerResolver
            from app.providers.clients import getClient

            model = model_fleet.getModelForRole('hippocampus')
            if not model:
                continue
            provider = providerResolver.resolve(model)
            if not provider:
                continue
            client = getClient(provider)
            if client and hasattr(client, 'generate'):
                transcript = '\n'.join((f'{m["role"]}: {m["content"][:200]}' for m in msgs))
                prompt = f'Summarize this session in one line (under 100 words):\n\n{transcript}'
                try:
                    loop = asyncio.get_event_loop()
                    summary = loop.run_until_complete(client.generate(prompt))
                except Exception:
                    summary = None
            else:
                summary = None
        except Exception:
            summary = None
        if not summary:
            last = msgs[0]
            content = last['content']
            if isinstance(content, str):
                summary = content[:200]
            else:
                summary = '(session ended)'
        write_timeline_event(sid, summary.strip()[:500], 'sweep')
        count += 1
    return count
