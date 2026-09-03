"""Part 21 P1 — M-1 usage decoupling + M-10 ttl_days wiring.

M-1 (usage-decoupling half): the cached BM25 corpus carries tokens + text
only. ``touch_fact_usage`` no longer invalidates the index — usage is
fetched per query for the candidate set — so the per-turn full-corpus
rebuild cliff is gone while the ranking boost still sees fresh counts.

M-10: the Memory UI's ttl_days reaches the facts store as ``expires_at``
(the manage endpoint accepted the field and silently dropped it).
"""

from __future__ import annotations


def test_touch_does_not_invalidate_index_but_boost_still_applies(isolatedData):
    from app.services.memory_store import fact_retrieval, save_fact, touch_fact_usage

    save_fact('a:plain', {'fact': 'deployment target is production cluster'}, title='Deploy A')
    save_fact('b:boosted', {'fact': 'destination for release trains'}, title='Ops B')
    query = 'deployment target destination'
    first = fact_retrieval.retrieve_relevant_facts(query, k=2)
    assert [f['key'] for f in first] == ['a:plain', 'b:boosted']

    index_before = fact_retrieval._caches.get('global')
    assert index_before is not None
    assert touch_fact_usage(['b:boosted']) == 1
    # THE FIX: a usage touch must NOT drop the cached corpus (rebuild cliff).
    assert fact_retrieval._caches.get('global') is index_before

    # Max boost (+1.0 after 20 touches) still flips the weaker lexical match
    # to #1 — usage is fetched fresh per query, not from the cached corpus.
    for _ in range(19):
        touch_fact_usage(['b:boosted'])
    ranked = fact_retrieval.retrieve_relevant_facts(query, k=2)
    assert ranked and ranked[0]['key'] == 'b:boosted'
    # The cache survives the whole loop — zero rebuilds after the first.
    assert fact_retrieval._caches.get('global') is index_before


def test_content_writes_still_invalidate_index(isolatedData):
    from app.services.memory_store import delete_fact, fact_retrieval, save_fact

    save_fact('x:one', {'fact': 'stable body'}, title='One')
    fact_retrieval.retrieve_relevant_facts('stable body', k=1)
    assert fact_retrieval._caches.get('global') is not None
    save_fact('x:two', {'fact': 'another body'}, title='Two')
    assert not fact_retrieval._caches, 'content writes must still rebuild'
    delete_fact('x:two')
    assert not fact_retrieval._caches


def test_manage_endpoint_ttl_wiring(isolatedData):
    from datetime import datetime, timedelta, timezone

    from app.main import app
    from app.services.memory_store import get_fact
    from fastapi.testclient import TestClient

    with TestClient(app) as client:
        posted = client.post(
            '/api/august/memory/manage',
            json={'action': 'set', 'key': 'user:ttlcheck', 'value': 'ttl wired', 'ttlDays': 7},
        )
        assert posted.status_code == 200, posted.text
        fact = get_fact('user:ttlcheck')
        assert fact is not None
        expires = str(fact.get('expiresAt') or '')
        assert expires, 'ttl_days was ignored — expires_at never set'
        got = datetime.fromisoformat(expires)
        delta = got - datetime.now(timezone.utc)
        assert timedelta(days=6) < delta < timedelta(days=8), delta

        # No ttl → the field stays unset (historical behavior preserved).
        posted = client.post(
            '/api/august/memory/manage',
            json={'action': 'set', 'key': 'user:nottl', 'value': 'no expiry'},
        )
        assert posted.status_code == 200
        fact = get_fact('user:nottl')
        assert fact is not None and not str(fact.get('expiresAt') or '').strip()


def test_m4_episodic_retention_sweep(isolatedData):
    """M-4: episodic_timeline was unbounded; consolidation now prunes rows
    older than episodicRetentionDays (default 90)."""
    from app.services.memory_store import _conn
    from app.services.memory_store.consolidation import _sweep_episodic, run_consolidation

    conn = _conn()
    conn.execute(
        "INSERT INTO episodic_timeline (timestamp, session_id, event_summary, category) "
        "VALUES (datetime('now', '-400 days'), 's-old', 'ancient event', 'activity')"
    )
    conn.execute(
        "INSERT INTO episodic_timeline (timestamp, session_id, event_summary, category) "
        "VALUES (datetime('now', '-2 days'), 's-new', 'recent event', 'activity')"
    )
    conn.commit()

    swept = _sweep_episodic()
    assert swept >= 1
    rows = conn.execute(
        "SELECT event_summary FROM episodic_timeline WHERE session_id IN ('s-old','s-new')"
    ).fetchall()
    summaries = {r['event_summary'] for r in rows}
    assert 'recent event' in summaries, 'fresh rows must survive'
    assert 'ancient event' not in summaries, 'stale row must be pruned'

    # Wired into the scheduled pass (summary reports the count).
    summary = run_consolidation()
    assert 'episodicSwept' in summary
