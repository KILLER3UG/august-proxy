"""Mid-run steer queue formatting and priority."""

from __future__ import annotations

import pytest

from app.services.workbench.sessions import create_workbench_session
from app.services.workbench.workbench import (
    _formatQueuedMessagesAsUserTurn,
    drainQueuedMessages,
    enqueueUserMessage,
)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    from app.config import settings
    from app.lib import paths
    from app.services.workbench import sessions as sess

    monkeypatch.setattr(paths, 'dataDir', lambda: tmp_path)
    settings.dataDir = tmp_path
    sess._sessions.clear()
    yield
    sess._sessions.clear()


def test_steer_prepends_and_formats():
    s = create_workbench_session()
    enqueueUserMessage(s.id, 'later follow-up', kind='queue')
    enqueueUserMessage(s.id, 'change approach now', kind='steer')
    entries = drainQueuedMessages(s.id)
    # steer was inserted at front
    assert entries[0]['kind'] == 'steer'
    assert entries[0]['text'] == 'change approach now'
    assert entries[1]['kind'] == 'queue'
    msg = _formatQueuedMessagesAsUserTurn(entries)
    assert msg['role'] == 'user'
    body = msg['content']
    assert 'STEER' in body
    assert '<steer' in body
    assert 'change approach now' in body
    assert '<queued_message' in body


def test_queue_default_kind():
    s = create_workbench_session()
    entry = enqueueUserMessage(s.id, 'hello')
    assert entry is not None
    assert entry.get('kind') == 'queue'
