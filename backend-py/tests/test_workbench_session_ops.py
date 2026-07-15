"""Session ops: undo last turn, branch, compact now."""

from __future__ import annotations

import pytest

from app.services.workbench.sessions import (
    branch_workbench_session,
    compact_workbench_session_now,
    create_workbench_session,
    get_workbench_session,
    undo_last_turn,
)


@pytest.fixture(autouse=True)
def _isolate_sessions(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths
    from app.services.workbench import sessions as sess

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    sess._sessions.clear()
    yield
    sess._sessions.clear()


def test_undo_last_turn_removes_user_and_following():
    s = create_workbench_session(provider='test', guardMode='full')
    s.messages = [
        {'role': 'user', 'content': 'first'},
        {'role': 'assistant', 'content': 'ok1'},
        {'role': 'user', 'content': 'second'},
        {'role': 'assistant', 'content': 'ok2'},
    ]
    s.messageCount = 4
    result = undo_last_turn(s.id)
    assert result is not None
    assert result['removed'] == 2
    session = get_workbench_session(s.id)
    assert session is not None
    assert len(session.messages) == 2
    assert session.messages[-1]['content'] == 'ok1'


def test_undo_nothing():
    s = create_workbench_session()
    result = undo_last_turn(s.id)
    assert result is not None
    assert result['removed'] == 0


def test_branch_copies_messages():
    s = create_workbench_session(provider='p', guardMode='ask')
    s.messages = [
        {'role': 'user', 'content': 'a'},
        {'role': 'assistant', 'content': 'b'},
        {'role': 'user', 'content': 'c'},
    ]
    s.messageCount = 3
    s.workspacePath = 'C:/proj'
    s.model = 'm1'
    branched = branch_workbench_session(s.id, up_to_index=1)
    assert branched is not None
    assert branched.id != s.id
    assert len(branched.messages) == 2
    assert branched.messages[0]['content'] == 'a'
    assert branched.workspacePath == 'C:/proj'
    assert 'branch' in branched.title.lower()


def test_compact_short_conversation_no_op():
    s = create_workbench_session()
    s.messages = [{'role': 'user', 'content': 'hi'}]
    s.messageCount = 1
    result = compact_workbench_session_now(s.id)
    assert result is not None
    assert result.get('underThreshold') is True
