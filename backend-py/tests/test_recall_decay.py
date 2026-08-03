"""Recency decay in recall ranking and memory eviction."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat().replace('+00:00', 'Z')


def _insert_row(conn, key, content, importance, ts, source='auto', pinned=0):
    conn.execute(
        'INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (key, content, 'auto', importance, source, pinned, ts, ts),
    )
    conn.commit()


def test_decay_factor_halves_per_month():
    from app.services.memory.auto_memory import _decay_factor

    assert 0.99 < _decay_factor(_iso(0)) <= 1.0
    assert abs(_decay_factor(_iso(30)) - 0.5) < 1e-6
    assert _decay_factor(_iso(150)) < 0.05
    assert _decay_factor(None) == 1.0


def test_stale_memory_loses_tie_to_fresh(brain_ready):
    """Identical relevance — recency decides the top-1."""
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    _insert_row(conn, 'fresh_mem', 'user prefers pnpm build tool', 0.9, _iso(1))
    _insert_row(conn, 'stale_mem', 'user prefers pnpm build tool', 0.9, _iso(400))

    results = am.getRelevantMemories('pnpm build tool', limit=1)
    assert len(results) == 1
    assert results[0]['key'] == 'fresh_mem'


def test_fresh_older_importance_still_loses_to_relevant_stale(brain_ready):
    """Relevance still dominates: a fresh but irrelevant row does not displace a
    strongly matching stale one in the top-k."""
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    _insert_row(conn, 'irrelevant_fresh', 'the weather today is nice', 0.9, _iso(1))
    _insert_row(conn, 'relevant_stale', 'user prefers pnpm build tool', 0.9, _iso(120))

    results = am.getRelevantMemories('pnpm build tool', limit=1)
    assert len(results) == 1
    assert results[0]['key'] == 'relevant_stale'


def test_eviction_prefers_stale_low_importance(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    now = _iso(0)
    for i in range(98):
        _insert_row(conn, f'fill_{i}', f'fill content {i}', 0.9, now)
    _insert_row(conn, 'fresh_low', 'fresh low importance', 0.1, now)
    _insert_row(conn, 'stale_med', 'stale medium importance', 0.6, _iso(200))
    am.saveAutoMemory('over_cap', 'new memory', importance=0.5)

    rows = {r['key'] for r in am.list_all_auto_memories()}
    assert 'stale_med' not in rows
    assert 'fresh_low' in rows
    assert len(rows) <= 100


def test_eviction_protects_user_and_pinned(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    now = _iso(0)
    for i in range(97):
        _insert_row(conn, f'fill_{i}', f'fill content {i}', 0.9, now)
    _insert_row(conn, 'user_row', 'user authored fact', 0.1, _iso(300), source='user')
    _insert_row(conn, 'pinned_row', 'pinned fact', 0.1, _iso(300), pinned=1)
    am.saveAutoMemory('over_cap2', 'new memory', importance=0.5)

    rows = {r['key'] for r in am.list_all_auto_memories()}
    assert 'user_row' in rows
    assert 'pinned_row' in rows
