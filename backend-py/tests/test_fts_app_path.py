"""App-path FTS5 hygiene — must hit FTS (not LIKE / full-table fallback).

Complements ``scripts/_check_fts_query_hygiene.py`` (static + live SQL probes).
"""

from __future__ import annotations

import sqlite3
from typing import Any
from unittest.mock import patch

import pytest

from app.services import memory_store
from app.services.memory import auto_memory


class _ConnSpy:
    def __init__(self, real: sqlite3.Connection) -> None:
        self._real = real
        self.sql: list[str] = []

    def execute(self, sql: str, params: Any = ()) -> Any:
        self.sql.append(str(sql))
        return self._real.execute(sql, params)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


def test_schema_old_content_match_invalid(isolatedData):
    memory_store.init()
    conn = memory_store._conn()
    cols_m = {r[1] for r in conn.execute('PRAGMA table_info(memory_store_fts)')}
    cols_a = {r[1] for r in conn.execute('PRAGMA table_info(auto_memories_fts)')}
    assert 'content' not in cols_m
    assert 'category' not in cols_a
    with pytest.raises(sqlite3.OperationalError):
        conn.execute(
            'SELECT key, value FROM memory_store_fts WHERE content MATCH ?',
            ('x',),
        ).fetchall()
    with pytest.raises(sqlite3.OperationalError):
        conn.execute(
            'SELECT key, content, category FROM auto_memories_fts WHERE content MATCH ?',
            ('x',),
        ).fetchall()


def test_search_memory_hits_fts_not_like(isolatedData):
    memory_store.init()
    memory_store.save_memory('project_alpha', 'alpha rocket launch notes for mission')
    memory_store.save_memory('unrelated_zeta', 'completely different topic')
    from app.services.memory_store import kv as kv_mod

    real = memory_store._conn()
    spy = _ConnSpy(real)
    # Patch where search_memory binds _conn (domain module), not the facade.
    with patch.object(kv_mod, '_conn', return_value=spy):
        hits = memory_store.search_memory('alpha rocket')
    keys = {h['key'] for h in hits}
    assert 'project_alpha' in keys
    assert 'unrelated_zeta' not in keys
    match_sql = [s for s in spy.sql if 'MATCH' in s.upper()]
    assert match_sql
    assert any('memory_store_fts MATCH' in s for s in match_sql)
    assert not any('content MATCH' in s for s in match_sql)
    assert not any(' LIKE ' in s.upper() for s in spy.sql)


def test_auto_memory_uses_join_and_table_match(isolatedData):
    memory_store.init()
    auto_memory.saveAutoMemory(
        'mem_alpha_unique',
        'User likes alpha rockets and orbital stages',
        category='pref',
        importance=0.9,
    )
    real = memory_store._conn()
    spy = _ConnSpy(real)
    with patch.object(auto_memory, '_conn', return_value=spy):
        hits = auto_memory.getRelevantMemories('alpha rockets', limit=5)
    # note: auto_memory._conn is its own wrapper around memory_store._conn
    assert hits
    join_sql = [s for s in spy.sql if 'auto_memories_fts' in s and 'JOIN' in s.upper()]
    assert join_sql
    assert any('auto_memories_fts MATCH' in s for s in join_sql)
