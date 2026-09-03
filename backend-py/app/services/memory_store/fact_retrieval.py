"""M3: BM25 fact retrieval that actually injects (plan 2026-08-27 §3.4).

The old intake snippet listed ~250 tokens of fact *names*, keyword-blind.
This module indexes the facts store (title + body) with the existing
pure-Python BM25 and retrieves the top-k entries relevant to the current
user message, rendered as a `<memory>` block that is appended to the user
message at the tail of the turn context — never into the system prompt, so
the provider prefix cache stays stable (cache-stability rule, §8 Q14).

No embeddings/vector store: BM25 over a few hundred facts is exact enough.
OQ4 (ruled 2026-09-04): August commits to NO vectors and reserves no schema
for them — the decisive precedent is the orphaned ``vector_entries`` table
(12 rows, zero code references) that a reserved schema outlived its feature
by; it is now dropped. Adding embeddings later is purely additive, so
reserving anything now would only recreate that dead weight.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

from app.services.memory_conn import conn as _conn

# ~400 tokens at ~4 chars/token.
_BLOCK_CHAR_CAP = 1600
# One entry's body never crowds out the rest.
_ENTRY_CHAR_CAP = 300
# Queries shorter than this get no BM25 injection (the intake
# brain_index_snippet fallback covers empty/short turns).
_MIN_QUERY_CHARS = 8
# Recency decay (Phase D): the usage boost halves per 30 days unused —
# often-quoted stale facts stop crowding out fresh ones. '' last_used_at
# (never used) gets NO decay; a fact earns its boost on first use.
_DECAY_HALF_LIFE_DAYS = 30.0

_lock = threading.Lock()
# M-2 (Part 21): one cached corpus PER SCOPE. A bot-scope corpus is the
# global ∪ bot union, so the union rule is baked into the index and queries
# stay O(1) cache hits. Keyed by normalized scope ('global' = plain store).
_caches: dict[str, dict[str, Any]] = {}


def invalidate_fact_index() -> None:
    """Drop every cached index (called on fact write/delete)."""
    with _lock:
        _caches.clear()


def _fact_body_text(value_raw: object) -> str:
    """Render a stored fact value as plain text for indexing/display."""
    loaded: object
    if isinstance(value_raw, str):
        try:
            loaded = json.loads(value_raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            loaded = value_raw
    elif value_raw is None:
        loaded = ''
    else:
        loaded = value_raw
    if isinstance(loaded, dict):
        parts = [str(loaded.get('fact') or '')]
        details = str(loaded.get('details') or '').strip()
        if details:
            parts.append(details)
        text = ' — '.join(p for p in parts if p)
    else:
        text = str(loaded)
    return ' '.join(text.split())


def _load_index(scope: str = 'global') -> dict[str, Any]:
    """Build the BM25 corpus for one scope (cached per scope).

    M-2 union rule: a scope's corpus is ``global ∪ this-scope`` — a Bot sees
    the user's shared memory plus its own notes, never another Bot's. The
    'global' scope degenerates to global-only (the pre-M-2 behavior, and
    every legacy row carries DEFAULT 'global').
    """
    from app.services.session_scope import GLOBAL_SCOPE, normalize_scope

    scope = normalize_scope(scope)
    with _lock:
        cached = _caches.get(scope)
        if cached is not None:
            return cached
    from app.services.tools.retrieval import BM25, _tokenize

    rows: list[dict[str, object]] = []
    corpus: list[list[str]] = []
    try:
        conn = _conn()
        # M-1 usage decoupling: the cached corpus carries tokens + text only
        # — never use_count/last_used_at. Usage is fetched per query for the
        # candidate set (see _usage_for), so touch_fact_usage no longer
        # invalidates this cache and the per-turn full-corpus rebuild cliff
        # is gone (Part 21 M-1).
        if scope == GLOBAL_SCOPE:
            scopeClause = "AND (scope IS NULL OR scope = 'global')"
            params: tuple[object, ...] = ()
        else:
            scopeClause = "AND (scope IS NULL OR scope = 'global' OR scope = ?)"
            params = (scope,)
        factRows = conn.execute(
            "SELECT fact_key, fact_value, title, kind, category FROM facts "
            "WHERE (expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday('now')) "
            "AND (status IS NULL OR status = 'active') "
            f"{scopeClause}",
            params,
        ).fetchall()
        for r in factRows:
            body = _fact_body_text(r['fact_value'])
            title = str(r['title'] or '').strip()
            key = str(r['fact_key'] or '')
            # Title + key words + body: titles carry the human phrasing the
            # model is most likely to echo back.
            text = f"{title} {key.replace('-', ' ').replace(':', ' ')} {body}"
            tokens = _tokenize(text)
            if not tokens:
                continue
            rows.append(
                {
                    'key': key,
                    'title': title,
                    'body': body,
                    'kind': str(r['kind'] or 'fact'),
                    'category': str(r['category'] or 'general'),
                }
            )
            corpus.append(tokens)
    except Exception as exc:
        logging.debug('fact index build failed: %s', exc)
        rows, corpus = [], []
    index = {'rows': rows, 'tokens': corpus, 'bm25': BM25(corpus) if corpus else None}
    with _lock:
        _caches[scope] = index
    return index


def find_similar_facts(
    text: str, k: int = 3, *, scope: str = 'global'
) -> list[tuple[float, str, str]]:
    """Top-k existing facts similar to ``text`` as ``(ratio, key, title)``.

    ``ratio = BM25(text→doc) / BM25(doc→doc)`` ∈ (0, 1] — a scale-free
    similarity suited to near-duplicate detection (M5 lesson dedupe, M4
    merge detection). Unlike ``retrieve_relevant_facts`` there is no usage
    boost and no minimum-query gate: callers compare ratios to thresholds.
    M-2: compared within the caller's scope union (a bot dedupes against
    global + its own notes, not other bots).
    """
    from app.services.tools.retrieval import _tokenize

    queryTokens = _tokenize((text or '').strip())
    if not queryTokens:
        return []
    index = _load_index(scope)
    bm25 = index.get('bm25')
    rows = index.get('rows')
    tokens = index.get('tokens')
    if bm25 is None or not rows or not tokens:
        return []
    scored: list[tuple[float, str, str]] = []
    for i, row in enumerate(rows):
        s = bm25.score(queryTokens, i)
        if s <= 0:
            continue
        docTokens = tokens[i]
        selfScore = bm25.score(docTokens, i) if docTokens else 0.0
        ratio = min(1.0, s / selfScore) if selfScore > 0 else 0.0
        scored.append((ratio, str(row.get('key')), str(row.get('title') or '')))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[: max(1, k)]


def _usage_decay(last_used_at: str) -> float:
    """Multiplier on the ``use_count`` boost — halves every 30 idle days.

    ``1.0`` when unused ('' / unparseable: a fact with no usage history has
    no staleness signal yet, so its boost stays at face value), decaying
    toward 0 as time since last use grows. Phase D (Part 17) item 3.
    """
    raw = (last_used_at or '').strip()
    if not raw:
        return 1.0
    try:
        from datetime import datetime, timezone

        # Stored as datetime('now') UTC — tolerate a trailing 'Z'/offset.
        normalized = raw[:-1] + '+00:00' if raw.endswith('Z') else raw
        lastUsed = datetime.fromisoformat(normalized)
        if lastUsed.tzinfo is None:
            lastUsed = lastUsed.replace(tzinfo=timezone.utc)
        days = max(0.0, (datetime.now(timezone.utc) - lastUsed).total_seconds() / 86400.0)
        return 0.5 ** (days / _DECAY_HALF_LIFE_DAYS)
    except (ValueError, TypeError):
        return 1.0


def _usage_for(keys: list[str]) -> dict[str, tuple[int, str]]:
    """Fresh ``(use_count, last_used_at)`` for a candidate key set.

    M-1 usage decoupling: usage no longer lives in the cached corpus, so
    ranking fetches it per query with one cheap SELECT over the candidates
    (≤200 — far above the k=5 window, so the boost can only reshuffle
    within the BM25-strongest set).
    """
    out: dict[str, tuple[int, str]] = {}
    uniq = [k for k in dict.fromkeys(keys) if k][:200]
    if not uniq:
        return out
    try:
        placeholders = ','.join('?' for _ in uniq)
        rows = _conn().execute(
            f'SELECT fact_key, use_count, last_used_at FROM facts '
            f'WHERE fact_key IN ({placeholders})',
            uniq,
        ).fetchall()
        for r in rows:
            out[str(r['fact_key'])] = (int(r['use_count'] or 0), str(r['last_used_at'] or ''))
    except Exception as exc:
        logging.debug('candidate usage fetch failed: %s', exc)
    return out


def retrieve_relevant_facts(
    query: str,
    k: int = 5,
    *,
    prior_turn: str = '',
    scope: str = 'global',
) -> list[dict[str, object]]:
    """Top-k active facts relevant to ``query``, usage-boosted.

    BM25 score plus a small ``use_count`` boost — the cheapest real
    "learns what's useful" signal without embeddings (plan §3.4).

    Phase D (Part 17): ``prior_turn`` (the previous *user* message) joins
    the query tokens — a follow-up like "and the second one?" stops being
    single-message myopic. Cheap: no extra calls, no history payload; the
    current message's tokens still dominate because they are scored
    separately and summed.

    M-2 (Part 21): ``scope`` selects the corpus union — 'global' (default,
    the pre-M-2 behavior) or 'bot:<id>' = global ∪ that bot's notes.
    """
    q = (query or '').strip()
    if len(q) < _MIN_QUERY_CHARS:
        return []
    index = _load_index(scope)
    bm25 = index.get('bm25')
    rows = index.get('rows')
    if bm25 is None or not rows:
        return []
    scored: list[tuple[float, dict[str, object]]] = []
    from app.services.tools.retrieval import _tokenize

    queryTokens = _tokenize(q)
    priorTokens = _tokenize((prior_turn or '').strip()) if (prior_turn or '').strip() else []
    if not queryTokens:
        return []
    for i, row in enumerate(rows):
        s = bm25.score(queryTokens, i)
        if priorTokens:
            # Follow-up expansion: prior-turn overlap counts at half
            # weight — context, not a substitute for the current ask.
            s += 0.5 * bm25.score(priorTokens, i)
        if s <= 0:
            continue
        scored.append((s, row))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    # Phase D item 3 + M-1 decoupling: the usage boost decays with idle
    # time (halved at 30 days unused); usage values are fetched fresh for
    # the candidate set — not from the (usage-free) cached corpus.
    usage = _usage_for([str(row.get('key')) for _, row in scored])
    boosted: list[tuple[float, dict[str, object]]] = []
    for s, row in scored:
        use_count, last_used_at = usage.get(str(row.get('key')), (0, ''))
        s += 0.05 * min(use_count, 20) * _usage_decay(last_used_at)
        boosted.append((s, row))
    boosted.sort(key=lambda pair: pair[0], reverse=True)
    return [dict(row) for _, row in boosted[: max(1, k)]]


def build_memory_block(
    query: str,
    k: int = 5,
    *,
    workspace: str = '',
    recalled: list[dict[str, object]] | None = None,
    prior_turn: str = '',
    scope: str = 'global',
) -> tuple[str, list[tuple[str, str]]]:
    """Render the `<memory>` injection block for one turn.

    Returns ``(block, injected)`` where ``injected`` is a list of
    ``(fact_key, title)`` pairs actually included — the turn-end usage
    feedback scans the assistant reply for these. Empty block when nothing
    relevant exists or the query is too short.

    Part 17 Phase A: with a ``workspace`` the block also carries the
    project's md-file entries as a tagged `project:` section (one tail,
    several tagged sections). Project entries do NOT join ``injected``
    (they have no facts-store key for usage feedback). When ``recalled``
    is a list, the rows actually injected (global + project) are appended
    to it as ``{key, category, snippet, scope}`` dicts — the chat UI's
    recalledMemories event payload (Phase A.4/C-13).

    Phase D item 2: ``prior_turn`` (the previous user message) expands the
    facts query — see :func:`retrieve_relevant_facts`.

    M-2 (Part 21): ``scope`` selects the facts corpus union for this turn —
    a Bot Chat passes ``'bot:<agentId>'`` so its `<memory>` block carries
    global ∪ own notes; regular sessions keep 'global'.
    """
    facts = retrieve_relevant_facts(query, k=k, prior_turn=prior_turn, scope=scope)
    projectSection = ''
    projectRows: list[dict[str, object]] = []
    if workspace:
        try:
            from app.services import project_memory as _pm

            projectSection = _pm.build_project_memory_tail(workspace, query)
            if projectSection and recalled is not None:
                for e in _pm.search_entries(workspace, query, k=3):
                    projectRows.append(
                        {
                            'key': f'project:{e.title}',
                            'category': 'project',
                            'snippet': e.body[:120],
                            'scope': 'project',
                        }
                    )
        except Exception:
            logging.debug('project memory tail build failed', exc_info=True)
    if not facts and not projectSection:
        return '', []
    lines: list[str] = ['<memory>']
    # One-line key index up front (Claude listing pattern): the model can
    # target remember/forget by exact key without a list_facts round-trip.
    keys = [str(f.get('key')) for f in facts if str(f.get('key') or '').strip()]
    if keys:
        lines.append('index: [' + ', '.join(keys) + ']')
    injected: list[tuple[str, str]] = []
    budget = _BLOCK_CHAR_CAP
    for f in facts:
        title = str(f.get('title') or '').strip()
        body = str(f.get('body') or '').strip()
        if len(body) > _ENTRY_CHAR_CAP:
            body = body[:_ENTRY_CHAR_CAP].rstrip() + '…'
        label = title or str(f.get('key'))
        line = f'- {label}: {body}' if body else f'- {label}'
        if budget - len(line) < 0 and lines:
            break
        budget -= len(line)
        lines.append(line)
        injected.append((str(f.get('key')), title))
    if projectSection and (budget - len(projectSection) >= 0 or not injected):
        # Project entries share the remaining tail budget; a section that
        # would overflow is dropped whole (never half-truncated).
        lines.append(projectSection)
        budget -= len(projectSection)
    if not injected and not projectSection:
        return '', []
    lines.append(
        'These are stored facts relevant to this message; cite them, update one by passing its key '
        'to remember, or remove a stale one with forget.'
    )
    lines.append('</memory>')
    if recalled is not None:
        recalled.extend(projectRows)
        for f in facts:
            if len(recalled) >= k + 3:
                break
            recalled.append(
                {
                    'key': str(f.get('key')),
                    'category': str(f.get('category') or 'general'),
                    'snippet': str(f.get('body') or '')[:120],
                    'scope': 'global',
                }
            )
    return '\n'.join(lines), injected
