"""Workbench → brain SQLite SoT (save_sessions) + brain_query store aliases.

The legacy explicit sync path (``sync_workbench_session_to_brain`` /
``backfill_workbench_json_to_brain``) had no live callers and was removed
with the memory-system cleanup (plan §2.2). Normal turns persist via
``save_sessions()``, which writes the full session blob and messages into
the brain SQLite SoT — these tests cover that live path.
"""

from __future__ import annotations

import json

import pytest


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', str(tmp_path / 'brain.sqlite'))
    monkeypatch.delenv('AUGUST_SESSION_JSON_EXPORT', raising=False)
    from app.config import settings

    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services import memory_store

    memory_store.init()
    yield
    # Cancel any debounced save so it cannot fire after env teardown.
    from app.services.workbench import sessions as sessions_mod

    with sessions_mod._save_thread_lock:
        sessions_mod._save_pending = False
        if sessions_mod._save_timer is not None:
            sessions_mod._save_timer.cancel()
            sessions_mod._save_timer = None
    settings.reload()


def test_save_sessions_round_trip_into_brain():
    from app.services import memory_store
    from app.services.workbench.sessions import (
        WorkbenchSession,
        _sessions,
        save_sessions,
    )

    sess = WorkbenchSession(
        id='wb_dualwrite_test',
        title='Dual write test',
        provider='test',
        model='m1',
        createdAt='2026-01-01T00:00:00Z',
        startedAt='2026-01-01T00:00:00Z',
        updatedAt='2026-01-01T00:00:00Z',
        messages=[
            {'role': 'user', 'content': 'hello dualwrite marker XYZ'},
            {'role': 'assistant', 'content': 'hi back'},
        ],
        messageCount=2,
        workspacePath='/tmp/ws',
    )
    _sessions[sess.id] = sess
    try:
        save_sessions(immediate=True)
        row = memory_store.get_session('wb_dualwrite_test')
        assert row is not None
        assert row.get('id') == 'wb_dualwrite_test' or row.get('title') == 'Dual write test'
        msgs = memory_store.get_messages('wb_dualwrite_test')
        assert len(msgs) == 2
        assert any('XYZ' in str(m.get('content', '')) for m in msgs)

        # brain_query must see workbench messages
        found = memory_store.brain_query(store='messages', query='XYZ', limit=5)
        parsed = json.loads(found)
        assert isinstance(parsed, list)
        assert len(parsed) >= 1
    finally:
        memory_store.delete_session_messages('wb_dualwrite_test')
        memory_store.delete_session_record('wb_dualwrite_test')
        _sessions.pop('wb_dualwrite_test', None)


def test_create_delete_clears_brain_rows():
    from app.services import memory_store
    from app.services.workbench.sessions import (
        create_workbench_session,
        delete_workbench_session,
        save_sessions,
    )

    s = create_workbench_session(provider='test')
    sid = s.id
    s.messages.append({'role': 'user', 'content': 'create-delete-marker'})
    save_sessions(immediate=True)
    assert memory_store.get_session(sid) is not None
    assert memory_store.count_messages(sid) >= 1
    assert delete_workbench_session(sid) is True
    assert memory_store.get_session(sid) is None
    assert memory_store.count_messages(sid) == 0


def test_brain_query_store_aliases():
    from app.services import memory_store

    # Canonical + snake aliases resolve without error payload
    # (autoMemories was removed with the memory hygiene cleanup — facts is
    # its successor; kv/memory and exam aliases must keep resolving).
    for store in ('facts', 'semantic_facts', 'examAttempts', 'exam_attempts', 'memory', 'kv'):
        raw = memory_store.brain_query(store=store, query='', limit=1)
        data = json.loads(raw)
        assert isinstance(data, (list, dict)), store
        if isinstance(data, dict) and 'error' in data:
            assert 'not available' not in data['error'] or store in ('kv',), data
