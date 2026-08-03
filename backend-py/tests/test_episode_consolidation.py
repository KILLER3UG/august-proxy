"""Episode consolidation: old conversation summaries merge into one episode."""

from __future__ import annotations

import pytest


def _seed_summaries(count: int):
    from app.services.memory import auto_memory as am

    for i in range(count):
        am.saveAutoMemory(
            f'conv_summary_wb_{i}',
            f'User asked: thing {i} (session wb_{i})',
            category='conversation',
            source='auto',
            importance=0.3,
        )


def _summary_keys():
    from app.services.memory import auto_memory as am

    return [m['key'] for m in am.list_all_auto_memories()]


def test_no_merge_below_threshold(brain_ready):
    from app.services.memory import auto_memory as am

    _seed_summaries(7)
    assert am.consolidate_conv_summaries() == 0
    keys = _summary_keys()
    assert sum(1 for k in keys if k.startswith('conv_summary_')) == 7
    assert not any(k.startswith('episode_') for k in keys)


def test_merges_oldest_five_at_threshold(brain_ready):
    from app.services.memory import auto_memory as am

    _seed_summaries(8)
    assert am.consolidate_conv_summaries() == 5
    keys = _summary_keys()
    assert sum(1 for k in keys if k.startswith('conv_summary_')) == 3
    assert any(k.startswith('episode_') for k in keys)


def test_episode_recallable(brain_ready):
    from app.services.memory import auto_memory as am

    _seed_summaries(8)
    am.consolidate_conv_summaries()
    hits = am.getRelevantMemories('thing 0')
    assert any(m['key'].startswith('episode_') for m in hits)


def test_repeated_consolidation_bounded(brain_ready):
    """Consolidating again after more summaries does not duplicate episodes."""
    from app.services.memory import auto_memory as am

    _seed_summaries(8)
    am.consolidate_conv_summaries()
    _seed_summaries(3)
    am.consolidate_conv_summaries()
    keys = _summary_keys()
    episodes = [k for k in keys if k.startswith('episode_')]
    assert len(episodes) >= 1
    assert len(episodes) <= 2


def test_episode_seq_survives_episode_deletion(brain_ready):
    """Deleting a middle episode must not collide with a live episode key."""
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    now = '2026-08-01T00:00:00Z'
    for i in range(1, 6):
        conn.execute(
            'INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (f'episode_{i}', f'episode body {i}', 'conversation', 0.55, 'auto', 0, now, now),
        )
    conn.commit()
    am.delete_auto_memory(
        conn.execute("SELECT id FROM auto_memories WHERE key = 'episode_2'").fetchone()['id']
    )
    _seed_summaries(8)
    am.consolidate_conv_summaries()
    keys = _summary_keys()
    episodes = [k for k in keys if k.startswith('episode_')]
    assert 'episode_6' in episodes
    assert episodes.count('episode_5') == 1  # no collision with the live row
