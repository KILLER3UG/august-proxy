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
    import asyncio

    s = create_workbench_session()
    s.messages = [{'role': 'user', 'content': 'hi'}]
    s.messageCount = 1
    result = asyncio.run(compact_workbench_session_now(s.id))
    assert result is not None
    assert result.get('underThreshold') is True


def test_compact_now_frees_memory_on_a_transcript_smaller_than_the_window_share():
    """The button's whole contract, and the only test that measured it.

    Handing the manual path the model's real window selects a token-budgeted tail
    of 16% of it, which for a modest transcript is larger than the transcript — the
    compaction then "succeeds" while freeing nothing, and the user is told the
    context is already compact. A session well under that share is exactly the case
    the button exists for, and until this test nothing covered a reduction at all.
    """
    import asyncio

    from app.providers.clients.base import estimateTokens

    s = create_workbench_session()
    s.messages = [{'role': 'system', 'content': 'you are a coding agent'}]
    for i in range(30):
        s.messages.append({'role': 'user', 'content': f'ask {i} ' + ('a' * 500)})
        s.messages.append({'role': 'assistant', 'content': f'ans {i} ' + ('b' * 500)})
    s.messageCount = len(s.messages)
    before = len(s.messages)
    beforeTokens = estimateTokens(s.messages)

    result = asyncio.run(compact_workbench_session_now(s.id))
    assert result is not None
    # Counts only: `result` carries the entire session, and a failure that dumps
    # 30 KB of transcript hides the one number that matters.
    assert result.get('underThreshold') is False, (
        f'the button freed nothing: {result.get("compressedCount")} of {before} messages, '
        f'{result.get("originalTokens")} -> {result.get("compressedTokens")} tokens'
    )
    assert result['compressedCount'] > 0
    assert estimateTokens(get_workbench_session(s.id).messages) < beforeTokens
    assert result['headCount'] in (0, 4)
