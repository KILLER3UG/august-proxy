"""Memory lifecycle: consolidation-first eviction and visible pruning."""

from __future__ import annotations

import pytest


def _insert_row(conn, key, content, importance, source='auto'):
    conn.execute(
        'INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) '
        'VALUES (?, ?, ?, ?, ?, 0, datetime("now"), datetime("now"))',
        (key, content, 'auto', importance, source),
    )
    conn.commit()


def _timeline_categories(conn) -> list[str]:
    rows = conn.execute('SELECT category FROM episodic_timeline').fetchall()
    return [str(r['category']) for r in rows]


def test_over_cap_prune_writes_timeline_event(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    for i in range(98):
        _insert_row(conn, f'fill_{i}', f'fill content {i}', 0.9)
    _insert_row(conn, 'fresh_low', 'fresh low importance', 0.1)
    _insert_row(conn, 'stale_low', 'stale low importance', 0.1)
    # 100 rows; one more save pushes over the cap and must prune visibly.
    am.saveAutoMemory('over_cap', 'new memory', importance=0.5)

    total = conn.execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c']
    assert int(total) <= 100
    assert 'memory' in _timeline_categories(conn)


def test_consolidation_first_avoids_eviction(brain_ready):
    """When overflow is conversation summaries, merging frees space — no prune."""
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    for i in range(8):
        am.saveAutoMemory(
            f'conv_summary_wb_{i}',
            f'User asked: thing {i} (session wb_{i})',
            category='conversation',
            source='auto',
            importance=0.3,
        )
    for i in range(93):
        _insert_row(conn, f'fill_{i}', f'fill content {i}', 0.9)
    # 101 rows; the next save triggers the cap, which merges summaries first.
    am.saveAutoMemory('new_mem', 'another memory', importance=0.5)

    total = conn.execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c']
    assert int(total) <= 100
    episodes = conn.execute("SELECT COUNT(*) AS c FROM auto_memories WHERE key LIKE 'episode_%'").fetchone()['c']
    assert int(episodes) == 1
    fills = conn.execute("SELECT COUNT(*) AS c FROM auto_memories WHERE key LIKE 'fill_%'").fetchone()['c']
    assert int(fills) == 93  # nothing pruned — summaries absorbed the overflow
    assert 'memory' not in _timeline_categories(conn)  # no silent-loss event


def test_eviction_still_respects_user_and_pinned(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.memory_store import _conn

    conn = _conn()
    for i in range(97):
        _insert_row(conn, f'fill_{i}', f'fill content {i}', 0.9)
    conn.execute(
        "INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) "
        "VALUES ('user_row', 'user fact', 'auto', 0.1, 'user', 0, datetime('now'), datetime('now'))"
    )
    conn.execute(
        "INSERT INTO auto_memories (key, content, category, importance, source, pinned, created_at, updated_at) "
        "VALUES ('pinned_row', 'pinned fact', 'auto', 0.1, 'auto', 1, datetime('now'), datetime('now'))"
    )
    conn.commit()
    am.saveAutoMemory('over_cap2', 'new memory', importance=0.5)

    rows = {r['key'] for r in conn.execute('SELECT key FROM auto_memories').fetchall()}
    assert 'user_row' in rows
    assert 'pinned_row' in rows
