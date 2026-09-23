"""M3: BM25 fact retrieval that actually injects (plan 2026-08-27 §3.4).

The old intake snippet listed ~250 tokens of fact *names*, keyword-blind.
This module indexes the facts store (title + body) with the existing
pure-Python BM25 and retrieves the top-k entries relevant to the current
user message, rendered as a `<memory>` block that is appended to the user
message at the tail of the turn context — never into the system prompt, so
the provider prefix cache stays stable (cache-stability rule, §8 Q14).

No embeddings/vector store: BM25 over a few hundred facts is exact enough.
Keyword recall is, however, the WRONG tool for one kind of fact: a profile
entry about *who the user is* has no lexical overlap with the message that
should have triggered it, so it competes for a BM25 slot it can never win and
August "forgets" the user. That kind gets its own always-on lane —
:func:`build_profile_block` — which reads the SAME cached corpus under the SAME
visibility/scope rules with no query, and renders first inside
:func:`build_memory_block`. Still one store, one scope resolver, one block
cap.

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
from app.services.memory_store.rest import PROFILE_FACT_KIND

# ~400 tokens at ~4 chars/token.
_BLOCK_CHAR_CAP = 1600
# One entry's body never crowds out the rest.
_ENTRY_CHAR_CAP = 300
# Queries shorter than this get no BM25 injection (the intake
# brain_index_snippet fallback covers empty/short turns).
_MIN_QUERY_CHARS = 8
# Recency decay: the usage boost halves per 30 days unused —
# often-quoted stale facts stop crowding out fresh ones. '' last_used_at
# (never used) gets NO decay; a fact earns its boost on first use.
_DECAY_HALF_LIFE_DAYS = 30.0
# The always-on profile lane's own budget. Deliberately well under HALF of
# _BLOCK_CHAR_CAP: a large profile set must never starve keyword recall, so
# ~150 tokens (600 chars) is all the lane may take, leaving ≥1000 chars of
# the unchanged 1600-char block for BM25 facts + the project tail. This is the
# lane's ONLY bound — a row-count cap would be a second budget, and it would
# drop facts nobody ever named.
_PROFILE_CHAR_CAP = 600
# Lane header: says out loud that this section is NOT keyword-matched, so the
# model does not report it as "only relevant when asked".
_PROFILE_LANE_HEADER = 'profile (always included, not keyword-matched):'
# A receipt naming omitted facts is itself bounded — naming the dropped facts
# must not eat the budget it exists to report on.
_OMITTED_RECEIPT_CHAR_CAP = 220
# ...and it needs at least this much room to say anything at all (the
# count-only form). The fitting pass reserves this, not the full cap, so a
# lane pays for the receipt it can actually carry instead of over-reserving.
_OMITTED_RECEIPT_MIN_ROOM = 64

_lock = threading.Lock()
# M-2: one cached corpus PER SCOPE. A bot-scope corpus is the
# global ∪ bot union, so the union rule is baked into the index and queries
# stay O(1) cache hits. Keyed by normalized scope ('global' = plain store).
_caches: dict[str, dict[str, Any]] = {}


def invalidate_fact_index(scope: str | None = None) -> None:
    """Drop cached indexes on fact write/delete.

    ``scope=None`` clears everything (bulk sweeps, store wipes). With a
    scope: a 'global' write must clear ALL caches (every union corpus
    contains global), while a scoped write only invalidates that scope's
    own corpus — the other unions are untouched by it.
    """
    with _lock:
        if scope is None:
            _caches.clear()
            return
        try:
            from app.services.session_scope import normalize_scope

            norm = normalize_scope(scope)
        except Exception:
            _caches.clear()
            return
        if norm == 'global':
            _caches.clear()
        else:
            _caches.pop(norm, None)


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
        # is gone.
        if scope == GLOBAL_SCOPE:
            scopeClause = "AND (scope IS NULL OR scope = 'global')"
            params: tuple[object, ...] = ()
        else:
            scopeClause = "AND (scope IS NULL OR scope = 'global' OR scope = ?)"
            params = (scope,)
        factRows = conn.execute(
            "SELECT fact_key, fact_value, title, kind, category, description, "
            "COALESCE(scope, 'global') AS scope, COALESCE(updated_at, '') AS updated_at FROM facts "
            "WHERE (expires_at IS NULL OR expires_at = '' OR julianday(expires_at) > julianday('now')) "
            "AND (status IS NULL OR status = 'active') "
            f"{scopeClause}",
            params,
        ).fetchall()
        for r in factRows:
            body = _fact_body_text(r['fact_value'])
            title = str(r['title'] or '').strip()
            key = str(r['fact_key'] or '')
            desc = ' '.join(str(r['description'] or '').split())
            # Title + description + key words + body: titles and the
            # ZCode-parity description hook carry the human phrasing the model
            # is most likely to echo back.
            text = f"{title} {desc} {key.replace('-', ' ').replace(':', ' ')} {body}"
            tokens = _tokenize(text)
            if not tokens:
                continue
            rows.append(
                {
                    'key': key,
                    'title': title,
                    'description': desc,
                    'body': body,
                    'kind': str(r['kind'] or 'fact'),
                    'category': str(r['category'] or 'general'),
                    # Carry the row's true scope — recall metrics
                    # and the transcript chip mislabeled bot-private recalls
                    # as 'global' (the hardcoded label).
                    'scope': str(r['scope'] or 'global'),
                    # Recency for the always-on profile lane. Safe to cache:
                    # updated_at only changes on a fact write, which already
                    # invalidates this corpus (unlike usage, which M-1 keeps
                    # out of the cache — see _usage_for).
                    'updated_at': str(r['updated_at'] or ''),
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
    prior_turn: str = '',
    scope: str = 'global',
    min_query_chars: int = _MIN_QUERY_CHARS,
) -> list[dict[str, object]]:
    """Top-k active facts relevant to ``query``, usage-boosted.

    ``min_query_chars`` separates the two callers, which need opposite rules:
    the automatic per-turn tail must not spend context on a 4-character message
    ("how about now"), while an *explicit* memory search the model chose to make
    ("my gpu", "keanu") must answer rather than silently return nothing. A
    caller that deliberately asked gets 1; an empty query is still refused,
    because "everything" is not a recall result.

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
    if len(q) < max(1, int(min_query_chars)):
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


# ── shared rendering (one shape for both recall lanes) ──────────────────────


def _fact_line(row: dict[str, object], *, entry_cap: int = _ENTRY_CHAR_CAP) -> str:
    """Render one corpus row as its ``- title: body`` line.

    Used by BOTH lanes (profile + BM25) so the two can never drift in shape,
    and so one long body never crowds out its neighbours.
    """
    title = str(row.get('title') or '').strip()
    body = str(row.get('body') or '').strip()
    if len(body) > entry_cap:
        body = body[:entry_cap].rstrip() + '…'
    label = title or str(row.get('key') or '')
    return f'- {label}: {body}' if body else f'- {label}'


def _row_identity(row: dict[str, object]) -> tuple[str, str]:
    """``(key, title)`` — the pair usage feedback and the receipt both speak."""
    return (str(row.get('key') or ''), str(row.get('title') or '').strip())


def _recalled_row(row: dict[str, object]) -> dict[str, object]:
    """The chat-UI ``recalledMemories`` shape for one injected fact row.

    Same four keys the BM25 lane has always emitted (no new field: the
    transcript chip and the recall metrics read these by name).
    """
    return {
        'key': str(row.get('key')),
        'category': str(row.get('category') or 'general'),
        'snippet': str(row.get('body') or '')[:120],
        'scope': str(row.get('scope') or 'global'),
    }


def _fit_lines(
    rows: list[dict[str, object]], budget: int
) -> tuple[list[str], list[dict[str, object]], list[tuple[str, str]]]:
    """Budget-pack already-ranked fact lines: ``(lines, included, omitted)``.

    Rank order is preserved — the first line that does not fit stops the lane
    (a later short line never jumps ahead of a dropped stronger one) and
    everything from there on comes back in ``omitted``, so the caller can
    NAME it instead of vanishing it. The first line always ships (the legacy
    rule): dropping the strongest match silently is worse than one
    over-budget line.
    """
    lines: list[str] = []
    included: list[dict[str, object]] = []
    omitted: list[tuple[str, str]] = []
    cost = 0
    for i, row in enumerate(rows):
        line = _fact_line(row)
        if lines and cost + len(line) + 1 > budget:
            omitted = [_row_identity(r) for r in rows[i:]]
            break
        cost += len(line) + 1
        lines.append(line)
        included.append(row)
    return lines, included, omitted


def _omitted_receipt(omitted: list[tuple[str, str]], max_chars: int, *, label: str) -> str:
    """The budget-honesty line: how many entries were dropped, and WHICH.

    A model shown a partial recall with no receipt concludes the omitted
    facts do not exist. Bounded by ``max_chars`` (as many titles named as
    fit, then ``(+N more)``), and it degrades to a count-only line under a
    tiny budget rather than dropping the receipt entirely.
    """
    if not omitted or max_chars <= 0:
        return ''
    names = [title or key or '(untitled)' for key, title in omitted]

    def _render(kept: int) -> str:
        more = len(names) - kept
        base = f'{label}: {len(names)} omitted for budget'
        shown = '; '.join(names[:kept])
        if kept and more:
            return f'{base}: {shown} (+{more} more)'
        if kept:
            return f'{base}: {shown}'
        return f'{base} (titles truncated)'

    for kept in range(len(names), -1, -1):
        line = _render(kept)
        if len(line) <= max_chars:
            return line
    return _render(0)[: max(0, max_chars - 1)] + '…'


def _rank_profile_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """Order profile rows with the EXISTING recall signals — no new scoring.

    The store's newest-first ``updated_at`` sequence, then the same decayed
    ``use_count`` boost :func:`retrieve_relevant_facts` applies
    (``0.05 * min(use_count, 20) * _usage_decay``) as a stable sort key, so an
    often-quoted profile fact leads the lane and a never-quoted one falls back
    to plain recency.
    """
    ranked = sorted(rows, key=lambda r: str(r.get('updated_at') or ''), reverse=True)
    usage = _usage_for([str(r.get('key') or '') for r in ranked])

    def _boost(row: dict[str, object]) -> float:
        use_count, last_used_at = usage.get(str(row.get('key') or ''), (0, ''))
        return 0.05 * min(use_count, 20) * _usage_decay(last_used_at)

    return sorted(ranked, key=_boost, reverse=True)


def build_profile_block(
    *,
    scope: str = 'global',
    budget_chars: int = _PROFILE_CHAR_CAP,
) -> tuple[str, list[dict[str, object]]]:
    """The always-on "who the user is" lane — never keyword-gated.

    A fact about the *user* must not have to win a BM25 slot against every
    other fact to be recalled: "user is a backend engineer in Seoul" shares no
    tokens with "why is my connection pool exhausting", so the keyword lane can
    surface it only by accident (the reported "August does not remember me").
    This lane returns the active, unexpired ``kind='profile'`` facts visible to
    ``scope`` with NO query at all.

    One authority per rule: the rows come from the same cached per-scope corpus
    :func:`_load_index` builds for BM25 — i.e. the same active + unexpired +
    ``global ∪ bot:<id>`` visibility, no second store, no second scope
    resolver — ordered by the existing recency/usage signals
    (:func:`_rank_profile_rows`) and bounded by its own explicit
    ``budget_chars``, which is deliberately far below ``_BLOCK_CHAR_CAP`` so
    the lane can never starve keyword recall. A profile fact that does not fit
    is NAMED in the returned text, never silently dropped — and when a budget
    is too small to carry both the bound and that receipt, the receipt wins
    (an honest over-long lane beats a tidy one that hides facts).

    Returns ``(lane_text, rows)`` where ``rows`` are the structured corpus
    entries actually included (``key``/``title``/``body``/``kind``/
    ``category``/``scope``), so the caller can fold them into its own
    injected/usage/recalled lists without re-deriving anything. ``('', [])``
    when the store holds no profile facts.

    Usable on its own: a caller that keeps per-turn keyword auto-injection off
    can still carry the user profile every turn.
    """
    index = _load_index(scope)
    corpus = index.get('rows') or []
    profileRows = [r for r in corpus if str(r.get('kind') or '') == PROFILE_FACT_KIND]
    if not profileRows:
        return '', []
    ranked = _rank_profile_rows(profileRows)
    budget = max(0, int(budget_chars))
    lineBudget = max(0, budget - (len(_PROFILE_LANE_HEADER) + 1))
    lines, included, omitted = _fit_lines(ranked, lineBudget)
    if omitted:
        # Re-pack once with room reserved for the receipt that names them —
        # a receipt that itself overflows the lane is not honest, just longer.
        # Reserve what a receipt NEEDS to say something (_OMITTED_RECEIPT_MIN_ROOM),
        # not its full cap, so the lane never wastes budget reserving text it
        # will not write.
        lines, included, omitted = _fit_lines(
            ranked, max(0, lineBudget - _OMITTED_RECEIPT_MIN_ROOM)
        )
    usedChars = len(_PROFILE_LANE_HEADER) + 1 + sum(len(line) + 1 for line in lines)
    # The receipt gets whatever room the lane has left — except under a budget
    # too small to carry even a count-only line, where it takes its full cap:
    # a silently missing profile fact is the exact failure this lane exists to
    # fix, so honesty outranks tidiness and the lane goes long instead.
    receiptRoom = budget - usedChars
    if omitted and receiptRoom < _OMITTED_RECEIPT_MIN_ROOM:
        receiptRoom = _OMITTED_RECEIPT_CHAR_CAP
    receipt = _omitted_receipt(omitted, receiptRoom, label='profile lane partial')
    parts = [_PROFILE_LANE_HEADER, *lines]
    if receipt:
        parts.append(receipt)
    return '\n'.join(parts), [dict(r) for r in included]


def build_profile_memory_block(
    *,
    scope: str = 'global',
    budget_chars: int = _PROFILE_CHAR_CAP,
) -> tuple[str, list[dict[str, object]]]:
    """The profile lane as a ready-to-inject ``<memory>`` block.

    ``build_profile_block`` returns lane *content*, because
    :func:`build_memory_block` composes it inside a block it tags itself. A
    caller that skips keyword auto-injection and injects the lane alone needs
    the same tag, or the model reads durable memory as part of the user's
    sentence. One place defines that tag; both off-gate callers use it.
    """
    lane, rows = build_profile_block(scope=scope, budget_chars=budget_chars)
    if not lane:
        return '', rows
    return f'<memory>\n{lane}\n</memory>', rows


def build_memory_block(
    query: str,
    k: int = 5,
    workspace: str = '',
    recalled: list[dict[str, object]] | None = None,
    prior_turn: str = '',
    scope: str = 'global',
) -> tuple[str, list[tuple[str, str]]]:
    """Render the `<memory>` injection block for one turn.

    Returns ``(block, injected)`` where ``injected`` is a list of
    ``(fact_key, title)`` pairs actually included — the turn-end usage
    feedback scans the assistant reply for these. Empty block when nothing
    relevant exists or the query is too short (the always-on profile lane is
    the one exception: it ships regardless of the query).

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

    Profile lane (2026-09-15): :func:`build_profile_block` is called first and
    its always-included ``kind='profile'`` section renders at the TOP of the
    block, before the BM25 matches — a fact about who the user is is recalled
    with zero lexical overlap with the message. The lane pays for itself out of
    the same unchanged ``_BLOCK_CHAR_CAP``, a fact it already shipped is never
    rendered twice, and facts dropped for budget are NAMED in a bounded
    ``recall partial:`` line instead of vanishing. With a corpus that holds no
    profile facts the output is what it has always been.

    Budget honesty note: the per-turn keyword auto-injection is the caller's
    gate (``memoryAutoInject``); a caller that keeps it off can still render
    the always-on lane by calling :func:`build_profile_block` directly.
    """
    profileLane, profileRows = build_profile_block(scope=scope)
    laneKeys = {str(r.get('key') or '') for r in profileRows}
    facts = [
        f
        for f in retrieve_relevant_facts(query, k=k, prior_turn=prior_turn, scope=scope)
        if str(f.get('key') or '') not in laneKeys
    ]
    projectSection = ''
    projectRows: list[dict[str, object]] = []
    if workspace:
        try:
            from app.services import project_memory as _pm

            # ONE search pass — the ranked entries feed both the
            # tail section and the recalled rows (they used to re-run the
            # identical md-read + BM25 scan twice per turn).
            ranked = _pm.search_entries(workspace, query, k=3)
            projectSection = _pm.build_project_memory_tail(
                workspace, query, ranked_entries=ranked
            )
            if projectSection and recalled is not None:
                for e in ranked:
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
    if not facts and not projectSection and not profileLane:
        return '', []
    lines: list[str] = ['<memory>']
    # One-line key index up front (Claude listing pattern): the model can
    # target remember/forget by exact key without a list_facts round-trip.
    keys = [
        key
        for key in [str(r.get('key') or '') for r in profileRows]
        + [str(f.get('key') or '') for f in facts]
        if key.strip()
    ]
    if keys:
        lines.append('index: [' + ', '.join(keys) + ']')
    # The lane renders FIRST, then keyword recall after it — and it is charged
    # against the same (unchanged) block cap, so a big profile set costs the
    # BM25 lane only its own _PROFILE_CHAR_CAP slice, never the whole block.
    budget = _BLOCK_CHAR_CAP - (len(profileLane) + 1 if profileLane else 0)
    factLines, includedFacts, omittedFacts = _fit_lines(facts, budget)
    if omittedFacts:
        # Re-pack once, reserving the receipt's FULL cap (unlike the lane,
        # which only reserves its minimum): the block has room to spare, and
        # paying up front keeps the whole `<memory>` block inside the
        # unchanged _BLOCK_CHAR_CAP.
        factLines, includedFacts, omittedFacts = _fit_lines(
            facts, max(0, budget - _OMITTED_RECEIPT_CHAR_CAP)
        )
    budget -= sum(len(line) for line in factLines)
    if profileLane:
        lines.append(profileLane)
    lines.extend(factLines)
    injected: list[tuple[str, str]] = [_row_identity(r) for r in profileRows]
    injected.extend(_row_identity(f) for f in includedFacts)
    if projectSection and (
        budget - len(projectSection) >= 0 or (not factLines and not profileLane)
    ):
        # Project entries share the remaining tail budget; a section that
        # would overflow is dropped whole (never half-truncated).
        lines.append(projectSection)
        budget -= len(projectSection)
    if not factLines and not projectSection and not profileLane:
        return '', []
    if omittedFacts:
        # Budget honesty (the 1600 cap is unchanged — say what it cost, and
        # pay for the receipt out of it): without this line the model reads a
        # partial recall as the whole store and concludes the missing facts
        # do not exist.
        lines.append(
            _omitted_receipt(omittedFacts, _OMITTED_RECEIPT_CHAR_CAP, label='recall partial')
        )
    lines.append(
        'These are stored facts relevant to this message; cite them, update one by passing its key '
        'to remember, or remove a stale one with forget.'
    )
    lines.append('</memory>')
    if recalled is not None:
        # Lane rows first (they render first), bounded by the same recall
        # width `k` so a big profile set cannot crowd the keyword rows out of
        # the transcript chip / recall metrics.
        for row in profileRows[: max(1, k)]:
            recalled.append(_recalled_row(row))
        recalled.extend(projectRows)
        for f in facts:
            if len(recalled) >= k + 3:
                break
            recalled.append(_recalled_row(f))
    return '\n'.join(lines), injected
