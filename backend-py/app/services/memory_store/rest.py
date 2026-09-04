"""Facts, proposals, lifecycle, topics, usage, timeline, stats."""
from __future__ import annotations

import json
from typing import cast

from app.json_narrowing import as_int, as_str
from app.services.memory_conn import conn as _conn
from app.services.memory_conn import db_path as _db_path
from app.services.memory_store.wire import _json, _row_as_wire
from app.type_aliases import FactDict, JsonValue, ProposalDict

_FACT_KINDS = frozenset({'fact', 'lesson', 'preference', 'skill-note'})


def derive_fact_title(text: str) -> str:
    """Short human label for a fact (readability ruling 2026-08-26: titled
    entries, not raw blobs). First sentence/clause, capped at 60 chars."""
    cleaned = ' '.join((text or '').split())
    for sep in ('. ', '! ', '? ', '; ', ' — ', ': '):
        at = cleaned.find(sep)
        if 8 <= at <= 80:
            cleaned = cleaned[:at]
            break
    if len(cleaned) > 60:
        cleaned = cleaned[:60].rstrip() + '…'
    return cleaned


def save_fact(
    factKey: str,
    factValue: JsonValue,
    category: str = 'general',
    source: str = '',
    confidence: float = 1.0,
    expires_at: str | None = None,
    title: str = '',
    kind: str = '',
    scope: str = 'global',
) -> None:
    """Save a structured fact. ``expires_at`` (ISO-8601 TEXT) is optional; the
    cognitive boot sweep purges facts whose expiry has passed.

    Upsert over the unique ``fact_key``: an update keeps the row id,
    ``created_at`` and usage counters, and only overwrites ``title``/``kind``
    when the caller actually supplies them (plan §3.3 — facts are titled,
    typed entries).

    M-2 (Part 21): ``scope`` ('global' | 'bot:<agentId>' | 'project:<path>')
    stamps the row's memory home on INSERT. An update never rewrites scope —
    a fact keeps the home it was born in (a bot touching an existing global
    key edits that global fact, same as any session does today).

    2.4 (Part 25): an upsert resets ``status`` to 'active' — re-remembering a
    key that consolidation had superseded/retired must revive it, or the model
    believes it saved while retrieval keeps filtering the stale row out.
    """
    from app.services.session_scope import normalize_scope

    conn = _conn()
    # '' = unspecified: fresh inserts default to 'fact', updates keep the
    # existing kind (a remember-without-kind must not downgrade a lesson).
    kindParam = kind if kind in _FACT_KINDS else ''
    conn.execute(
        """
        INSERT INTO facts (fact_key, fact_value, title, kind, category, source, confidence, expires_at, scope, updated_at)
        VALUES (?, ?, ?, COALESCE(NULLIF(?, ''), 'fact'), ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(fact_key) DO UPDATE SET
            fact_value = excluded.fact_value,
            title = CASE WHEN excluded.title != '' THEN excluded.title ELSE facts.title END,
            kind = CASE WHEN excluded.kind != '' THEN excluded.kind ELSE facts.kind END,
            category = excluded.category,
            source = excluded.source,
            confidence = excluded.confidence,
            expires_at = excluded.expires_at,
            status = 'active',
            updated_at = datetime('now')
        """,
        (
            factKey,
            _json(factValue),
            (title or '').strip(),
            kindParam,
            category,
            source,
            confidence,
            expires_at,
            normalize_scope(scope),
        ),
    )
    conn.commit()
    try:
        from app.services.memory_store.fact_retrieval import invalidate_fact_index

        invalidate_fact_index()
    except Exception:
        pass


def touch_fact_usage(factKeys: list[str]) -> int:
    """Increment ``use_count`` / ``last_used_at`` for referenced facts.

    M3 usage feedback: an injected fact the model quotes (or updates via
    ``remember``) is marked as used; BM25 retrieval gives a small rank boost
    to high-use entries. Returns the number of rows touched. Since M-1's
    usage decoupling this does NOT touch the cached BM25 corpus — ranking
    reads fresh usage per query.
    """
    if not factKeys:
        return 0
    conn = _conn()
    touched = 0
    for key in factKeys:
        key = (key or '').strip()
        if not key:
            continue
        cur = conn.execute(
            "UPDATE facts SET use_count = COALESCE(use_count, 0) + 1, "
            "last_used_at = datetime('now') WHERE fact_key = ?",
            (key,),
        )
        touched += max(0, int(cur.rowcount))
    if touched:
        conn.commit()
        # M-1 usage decoupling (Part 21): NO invalidate_fact_index here.
        # The cached corpus no longer carries use_count/last_used_at —
        # ranking fetches fresh usage per query for the candidate set — so
        # a touch no longer triggers the full-corpus rebuild cliff.
    return touched


def get_fact(factKey: str) -> FactDict | None:
    """Get a fact by key."""
    conn = _conn()
    row = conn.execute('SELECT * FROM facts WHERE fact_key = ?', (factKey,)).fetchone()
    if not row:
        return None
    return cast(FactDict, _row_as_wire(row))


def _visibility_where(scope: str) -> tuple[str, list[object]]:
    """2.2 (Part 25): the shared read-visibility clause for the facts store —
    active + unexpired + the M-2 scope union (global ∪ this-scope). Every
    non-ranked facts read (list_facts / search_facts) must apply it, or a Bot
    sees every other Bot's private keys plus superseded/retired/expired rows.
    """
    from app.services.session_scope import GLOBAL_SCOPE, normalize_scope

    s = normalize_scope(scope)
    parts = [
        "(status IS NULL OR status = 'active')",
        "(expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday('now'))",
    ]
    params: list[object] = []
    if s == GLOBAL_SCOPE:
        parts.append("(scope IS NULL OR scope = 'global')")
    else:
        parts.append("(scope IS NULL OR scope = 'global' OR scope = ?)")
        params.append(s)
    return ' AND '.join(parts), params


def search_facts(query: str, category: str = '', scope: str = 'global') -> list[FactDict]:
    """Search facts by key or value (visible-to-``scope`` only — 2.2)."""
    conn = _conn()
    # Escape LIKE wildcards so `100%` / `my_note` don't over-match.
    escaped = (query or '').replace('%', r'\%').replace('_', r'\_')
    like = f'%{escaped}%'
    vis, visParams = _visibility_where(scope)
    if category:
        rows = conn.execute(
            "SELECT * FROM facts WHERE (fact_key LIKE ? ESCAPE '\\' OR fact_value LIKE ? ESCAPE '\\') "
            f"AND category = ? AND {vis} ORDER BY updated_at DESC LIMIT 20",
            (like, like, category, *visParams),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM facts WHERE (fact_key LIKE ? ESCAPE '\\' OR fact_value LIKE ? ESCAPE '\\') "
            f"AND {vis} ORDER BY updated_at DESC LIMIT 20",
            (like, like, *visParams),
        ).fetchall()
    return [cast(FactDict, _row_as_wire(r)) for r in rows]


def list_facts(category: str = '', scope: str = 'global') -> list[FactDict]:
    """List facts visible to ``scope`` (active + unexpired — 2.2), optionally
    filtered by category."""
    conn = _conn()
    vis, visParams = _visibility_where(scope)
    if category:
        rows = conn.execute(
            f'SELECT * FROM facts WHERE category = ? AND {vis} ORDER BY updated_at DESC',
            (category, *visParams),
        ).fetchall()
    else:
        rows = conn.execute(
            f'SELECT * FROM facts WHERE {vis} ORDER BY updated_at DESC',
            tuple(visParams),
        ).fetchall()
    return [cast(FactDict, _row_as_wire(r)) for r in rows]


def delete_fact(factKey: str) -> bool:
    """Delete a fact by key."""
    conn = _conn()
    cursor = conn.execute('DELETE FROM facts WHERE fact_key = ?', (factKey,))
    conn.commit()
    if cursor.rowcount > 0:
        try:
            from app.services.memory_store.fact_retrieval import invalidate_fact_index

            invalidate_fact_index()
        except Exception:
            pass
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
    from app.services.deferred_writes import defer_commit

    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO lifecycle (session_id, event_type, detail) VALUES (?, ?, ?)',
        (sessionId, eventType, _json(detail) if detail else None),
    )
    # P4.2 (Part 18): lifecycle rows are diagnostics, not read back
    # cross-thread within the turn — debounce the commit (≤2s).
    defer_commit(conn)
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


def resolve_sot_session_id(sessionId: str) -> str:
    """Prefer a workbench / sessions-table SoT id when recording or looking up usage.

    If ``sessionId`` already exists on ``sessions``, keep it. If a workbench
    blob exists with that id, keep it. Otherwise return the given id unchanged
    (callers may pass a provisional frontend id before linking).
    """
    sid = (sessionId or '').strip()
    if not sid:
        return sid
    conn = _conn()
    row = conn.execute('SELECT id FROM sessions WHERE id = ? LIMIT 1', (sid,)).fetchone()
    if row:
        return str(row['id'] if isinstance(row, dict) or hasattr(row, 'keys') else row[0])
    # Also accept ids that only appear on usage already (historical)
    return sid


def record_usage(
    sessionId: str,
    model: str,
    inputTokens: int = 0,
    outputTokens: int = 0,
    contextTokens: int = 0,
    cacheHitTokens: int = 0,
    cacheMissTokens: int = 0,
) -> int:
    """Record a usage event against the session SoT id when known.

    ``contextTokens`` captures the provider-reported ``inputTokens`` of the
    FINAL sub-call in the agentic turn — i.e. the true current context fill
    (system prompt + tools + messages, counted once). The cumulative
    ``inputTokens``/``outputTokens`` are still recorded for Usage-page totals.

    ``cacheHitTokens``/``cacheMissTokens`` carry the universal prompt-cache
    split (Anthropic cache_read/cache_creation vs OpenAI-compatible
    prompt_cache_hit/miss) so the UI can show the cache hit rate.
    """
    sot_id = resolve_sot_session_id(sessionId)
    conn = _conn()
    cursor = conn.execute(
        'INSERT INTO usage_events (session_id, model, input_tokens, output_tokens, context_tokens, cache_hit_tokens, cache_miss_tokens) '
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
        (sot_id, model, inputTokens, outputTokens, contextTokens, cacheHitTokens, cacheMissTokens),
    )
    conn.commit()
    return as_int(cursor.lastrowid)


def list_usage(*, limit: int = 200) -> list[dict[str, object]]:
    """List recent usage events (newest first), for GET /api/usage."""
    conn = _conn()
    lim = max(1, min(int(limit), 1000))
    rows = conn.execute(
        'SELECT id, session_id, model, input_tokens, output_tokens, context_tokens, created_at '
        'FROM usage_events ORDER BY created_at DESC, id DESC LIMIT ?',
        (lim,),
    ).fetchall()
    return [_row_as_wire(r) for r in rows]


def get_usage(sessionId: str) -> dict[str, object]:
    """Get aggregated usage for a session.

    Resolves to the session SoT id when the id exists on ``sessions``.
    Returns cumulative totals (for the Usage page) plus ``latestContextTokens``
    — the ``contextTokens`` of the most recent usage event, which equals the
    provider-reported inputTokens of the final sub-call of the latest turn
    (the true current context fill). Also returns the per-event list ordered
    newest-first so the caller can derive the same value independently.
    """
    sessionId = resolve_sot_session_id(sessionId)
    conn = _conn()
    row = conn.execute(
        'SELECT SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, '
        'SUM(cache_hit_tokens) as total_cache_hit, SUM(cache_miss_tokens) as total_cache_miss, '
        'COUNT(*) as request_count FROM usage_events WHERE session_id = ?',
        (sessionId,),
    ).fetchone()
    totals = dict(row) if row else {
        'total_input': 0, 'total_output': 0, 'total_cache_hit': 0, 'total_cache_miss': 0, 'request_count': 0
    }
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
            'SELECT id, model, input_tokens, output_tokens, context_tokens, cache_hit_tokens, cache_miss_tokens, created_at FROM usage_events WHERE session_id = ? ORDER BY created_at DESC, id DESC',
            (sessionId,),
        ).fetchall()
    ]
    cache_hit = totals.get('total_cache_hit', 0) or 0
    cache_miss = totals.get('total_cache_miss', 0) or 0
    cache_total = cache_hit + cache_miss
    # Cost: per-event sum using the shared pricing table (the composer chip,
    # the spend ceiling, and this endpoint must agree). Never raises.
    total_cost = 0.0
    try:
        from app.services.cost_estimator import session_cost_usd

        for e in conn.execute(
            'SELECT model, input_tokens, output_tokens, cache_hit_tokens, cache_miss_tokens FROM usage_events WHERE session_id = ?',
            (sessionId,),
        ).fetchall():
            total_cost += session_cost_usd(
                model_id=as_str(e['model'], ''),
                total_in=as_int(e['input_tokens'], 0),
                total_out=as_int(e['output_tokens'], 0),
                cache_hit=as_int(e['cache_hit_tokens'], 0),
                cache_miss=as_int(e['cache_miss_tokens'], 0),
            )
        total_cost = round(total_cost, 4)
    except Exception:
        total_cost = 0.0
    return {
        'sessionId': sessionId,
        'totalEvents': totals.get('request_count', 0) or 0,
        'totalInputTokens': totals.get('total_input', 0) or 0,
        'totalOutputTokens': totals.get('total_output', 0) or 0,
        'totalTokens': (totals.get('total_input', 0) or 0) + (totals.get('total_output', 0) or 0),
        'cacheHitTokens': cache_hit,
        'cacheMissTokens': cache_miss,
        'cacheHitRate': round(cache_hit / cache_total, 3) if cache_total else 0.0,
        'totalCost': total_cost,
        'model': events[0]['model'] if events else None,
        'provider': None,
        'contextTokens': latestCtx,
        'latestContextTokens': latestCtx,
        'events': events,
    }


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


def write_timeline_event(sessionId: str | None, eventSummary: str, category: str = 'general') -> int:
    """v2: Append an entry to episodic_timeline. Returns the new row's id.

    ``sessionId`` is optional — system events (e.g. memory lifecycle) have
    no owning session.
    """
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO episodic_timeline (timestamp, session_id, event_summary, category) VALUES (datetime('now'), ?, ?, ?)",
        (sessionId, eventSummary, category),
    )
    conn.commit()
    return as_int(cur.lastrowid)
