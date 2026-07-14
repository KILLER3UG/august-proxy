"""Facts, proposals, lifecycle, topics, usage, timeline, stats."""
from __future__ import annotations
import asyncio
import json
from typing import cast
from app.json_narrowing import as_int
from app.services.memory_conn import conn as _conn, db_path as _db_path
from app.services.memory_store.wire import _json, _row_as_wire
from app.type_aliases import FactDict, JsonValue, ProposalDict

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
