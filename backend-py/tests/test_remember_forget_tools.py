"""Tests for the remember / forget memory tools and pinned storage."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_remember_writes_row(brain_ready):
    from app.services.memory_store import _conn
    from app.services.tool_registrations.memory_tools import _rememberMemory

    out = await _rememberMemory('User prefers pnpm over npm', category='preference')
    assert 'Remembered' in out
    row = _conn().execute('SELECT * FROM auto_memories').fetchone()
    assert row is not None
    assert row['key'].startswith('remembered_')
    assert row['importance'] == 0.7
    assert row['category'] == 'preference'
    assert row['source'] == 'auto'
    assert row['pinned'] == 0


@pytest.mark.asyncio
async def test_remember_same_fact_refreshes_same_row(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.tool_registrations.memory_tools import _rememberMemory

    await _rememberMemory('User prefers pnpm over npm')
    await _rememberMemory('User prefers pnpm over npm')
    rows = am.list_all_auto_memories()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_remember_exact_repeat_reinforces(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.tool_registrations.memory_tools import _rememberMemory

    await _rememberMemory('User prefers pnpm over npm')
    await _rememberMemory('User prefers pnpm over npm')
    rows = am.list_all_auto_memories()
    assert len(rows) == 1
    assert rows[0]['importance'] > 0.7  # repeat confirms: importance bumps


@pytest.mark.asyncio
async def test_remember_pinned_after_unpinned_write(brain_ready):
    """Pinning a memory that already exists must stick (writes never unpin)."""
    from app.services.memory import auto_memory as am
    from app.services.tool_registrations.memory_tools import _rememberMemory

    await _rememberMemory('Always run tests before commit')
    assert am.list_user_added_memories() == []  # not pinned yet
    await _rememberMemory('Always run tests before commit', pinned=True)
    rows = am.list_user_added_memories()
    assert len(rows) == 1
    assert rows[0]['pinned'] == 1


@pytest.mark.asyncio
async def test_remember_near_dup_bumps_importance(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.tool_registrations.memory_tools import _rememberMemory

    await _rememberMemory('The user prefers pnpm over npm for installs')
    await _rememberMemory('User prefers pnpm over npm')
    rows = am.list_all_auto_memories()
    assert len(rows) == 1
    assert rows[0]['importance'] > 0.7  # near-dup bumped it above the default


@pytest.mark.asyncio
async def test_remember_pinned_is_always_loaded(brain_ready):
    from app.services.memory import auto_memory as am
    from app.services.tool_registrations.memory_tools import _rememberMemory

    await _rememberMemory('Always run tests before commit', category='correction', pinned=True)
    rows = am.list_user_added_memories()
    assert len(rows) == 1
    assert rows[0]['pinned'] == 1


@pytest.mark.asyncio
async def test_forget_deletes_row(brain_ready):
    from app.services.memory_store import _conn
    from app.services.tool_registrations.memory_tools import _forgetMemory, _rememberMemory

    await _rememberMemory('Temporary fact to forget')
    row = _conn().execute('SELECT * FROM auto_memories').fetchone()
    out = await _forgetMemory(row['id'])
    assert 'Deleted' in out
    assert _conn().execute('SELECT COUNT(*) AS c FROM auto_memories').fetchone()['c'] == 0


@pytest.mark.asyncio
async def test_forget_missing_id_reports(brain_ready):
    from app.services.tool_registrations.memory_tools import _forgetMemory

    out = await _forgetMemory(999999)
    assert 'No memory found' in out


@pytest.mark.asyncio
async def test_remember_dispatchable_through_registry(brain_ready):
    from app.services import tool_registry
    from app.services.tool_registrations import memory_tools

    memory_tools.register()
    out = await tool_registry.dispatch('remember', {'content': 'Prefer dark mode'})
    assert 'Remembered' in out


def test_pinned_column_exists_after_schema(brain_ready):
    cols = {r['name'] for r in brain_ready.execute('PRAGMA table_info(auto_memories)').fetchall()}
    assert 'pinned' in cols


def test_pinned_column_added_on_warm_upgrade(tmp_path, monkeypatch):
    """A legacy DB without the column gains it via the additive migration."""
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.services.memory_schema import ensure_schema
    from app.services.memory_store import _conn

    conn = _conn()
    conn.execute('DROP TABLE IF EXISTS auto_memories_fts')
    conn.execute('DROP TABLE IF EXISTS auto_memories')
    conn.execute(
        'CREATE TABLE auto_memories ('
        'id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, content TEXT, '
        'category TEXT DEFAULT "auto", importance REAL DEFAULT 0.5, '
        'source TEXT DEFAULT "", created_at TEXT, updated_at TEXT)'
    )
    conn.execute('PRAGMA user_version=8')
    conn.commit()
    ensure_schema(conn)
    conn.commit()
    cols = {r['name'] for r in conn.execute('PRAGMA table_info(auto_memories)').fetchall()}
    assert 'pinned' in cols
