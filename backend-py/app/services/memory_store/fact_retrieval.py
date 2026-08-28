"""M3: BM25 fact retrieval that actually injects (plan 2026-08-27 §3.4).

The old intake snippet listed ~250 tokens of fact *names*, keyword-blind.
This module indexes the facts store (title + body) with the existing
pure-Python BM25 and retrieves the top-k entries relevant to the current
user message, rendered as a `<memory>` block that is appended to the user
message at the tail of the turn context — never into the system prompt, so
the provider prefix cache stays stable (cache-stability rule, §8 Q14).

No embeddings/vector store: BM25 over a few hundred facts is exact enough.
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

_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def invalidate_fact_index() -> None:
    """Drop the cached index (called on fact write/delete)."""
    global _cache
    with _lock:
        _cache = None


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


def _load_index() -> dict[str, Any]:
    """Build the BM25 corpus from active, unexpired facts (cached)."""
    global _cache
    with _lock:
        if _cache is not None:
            return _cache
    from app.services.tools.retrieval import BM25, _tokenize

    rows: list[dict[str, object]] = []
    corpus: list[list[str]] = []
    try:
        conn = _conn()
        factRows = conn.execute(
            "SELECT fact_key, fact_value, title, kind, category, use_count FROM facts "
            "WHERE (expires_at IS NULL OR expires_at = '' OR expires_at > datetime('now')) "
            "AND (status IS NULL OR status = 'active')"
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
                    'use_count': int(r['use_count'] or 0),
                }
            )
            corpus.append(tokens)
    except Exception as exc:
        logging.debug('fact index build failed: %s', exc)
        rows, corpus = [], []
    index = {'rows': rows, 'tokens': corpus, 'bm25': BM25(corpus) if corpus else None}
    with _lock:
        _cache = index
    return index


def find_similar_facts(text: str, k: int = 3) -> list[tuple[float, str, str]]:
    """Top-k existing facts similar to ``text`` as ``(ratio, key, title)``.

    ``ratio = BM25(text→doc) / BM25(doc→doc)`` ∈ (0, 1] — a scale-free
    similarity suited to near-duplicate detection (M5 lesson dedupe, M4
    merge detection). Unlike ``retrieve_relevant_facts`` there is no usage
    boost and no minimum-query gate: callers compare ratios to thresholds.
    """
    from app.services.tools.retrieval import _tokenize

    queryTokens = _tokenize((text or '').strip())
    if not queryTokens:
        return []
    index = _load_index()
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


def retrieve_relevant_facts(query: str, k: int = 5) -> list[dict[str, object]]:
    """Top-k active facts relevant to ``query``, usage-boosted.

    BM25 score plus a small ``use_count`` boost — the cheapest real
    "learns what's useful" signal without embeddings (plan §3.4).
    """
    q = (query or '').strip()
    if len(q) < _MIN_QUERY_CHARS:
        return []
    index = _load_index()
    bm25 = index.get('bm25')
    rows = index.get('rows')
    if bm25 is None or not rows:
        return []
    scored: list[tuple[float, dict[str, object]]] = []
    from app.services.tools.retrieval import _tokenize

    queryTokens = _tokenize(q)
    if not queryTokens:
        return []
    for i, row in enumerate(rows):
        s = bm25.score(queryTokens, i)
        if s <= 0:
            continue
        s += 0.05 * min(int(row.get('use_count') or 0), 20)
        scored.append((s, row))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [dict(row) for _, row in scored[: max(1, k)]]


def build_memory_block(query: str, k: int = 5) -> tuple[str, list[tuple[str, str]]]:
    """Render the `<memory>` injection block for one turn.

    Returns ``(block, injected)`` where ``injected`` is a list of
    ``(fact_key, title)`` pairs actually included — the turn-end usage
    feedback scans the assistant reply for these. Empty block when nothing
    relevant exists or the query is too short.
    """
    facts = retrieve_relevant_facts(query, k=k)
    if not facts:
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
    if not injected:
        return '', []
    lines.append(
        'These are stored facts relevant to this message; cite them, update one by passing its key '
        'to remember, or remove a stale one with forget.'
    )
    lines.append('</memory>')
    return '\n'.join(lines), injected
