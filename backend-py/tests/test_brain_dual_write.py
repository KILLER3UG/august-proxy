"""Workbench dual-write into brain sessions/messages + store aliases."""

from __future__ import annotations

import json

import pytest
from app.services import memory_store
from app.services.workbench.brain_sync import sync_workbench_session_to_brain
from app.services.workbench.sessions import (
    WorkbenchSession,
    create_workbench_session,
    delete_workbench_session,
)


@pytest.fixture(autouse=True)
def _init_db():
    memory_store.init()
    yield


def test_sync_workbench_session_to_brain_round_trip():
    session = WorkbenchSession(
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
    try:
        sync_workbench_session_to_brain(session)
        row = memory_store.get_session('wb_dualwrite_test')
        assert row is not None
        assert row.get('id') == 'wb_dualwrite_test' or row.get('title') == 'Dual write test'
        msgs = memory_store.get_messages('wb_dualwrite_test')
        assert len(msgs) == 2
        assert any('XYZ' in str(m.get('content', '')) for m in msgs)

        # brain_query must see workbench messages (store name aliases too)
        found = memory_store.brain_query(store='messages', query='XYZ', limit=5)
        parsed = json.loads(found)
        assert isinstance(parsed, list)
        assert len(parsed) >= 1

        alias = memory_store.brain_query(store='auto_memories', query='', limit=1)
        # empty query may return rows or empty list — must not be "not available"
        parsed_alias = json.loads(alias)
        assert not (isinstance(parsed_alias, dict) and 'not available' in str(parsed_alias.get('error', '')))
    finally:
        memory_store.delete_session_messages('wb_dualwrite_test')
        memory_store.delete_session_record('wb_dualwrite_test')


def test_create_delete_clears_brain_rows():
    s = create_workbench_session(provider='test')
    sid = s.id
    s.messages.append({'role': 'user', 'content': 'create-delete-marker'})
    sync_workbench_session_to_brain(s)
    assert memory_store.get_session(sid) is not None
    assert memory_store.count_messages(sid) >= 1
    assert delete_workbench_session(sid) is True
    assert memory_store.get_session(sid) is None
    assert memory_store.count_messages(sid) == 0


def test_brain_query_store_aliases():
    # Canonical + snake aliases resolve without error payload
    for store in ('autoMemories', 'auto_memories', 'examAttempts', 'exam_attempts', 'memory', 'kv'):
        raw = memory_store.brain_query(store=store, query='', limit=1)
        data = json.loads(raw)
        assert isinstance(data, (list, dict)), store
        if isinstance(data, dict) and 'error' in data:
            assert 'not available' not in data['error'] or store in ('kv',), data
