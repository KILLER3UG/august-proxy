"""GET /api/usage must return real usage_events rows."""

from __future__ import annotations

from app.services import memory_store


def test_list_usage_returns_recorded_events():
    memory_store.init()
    sid = 'usage_list_test_session'
    eid = memory_store.record_usage(sid, 'test-model', inputTokens=11, outputTokens=7, contextTokens=11)
    assert eid > 0
    events = memory_store.list_usage(limit=50)
    assert isinstance(events, list)
    assert any(
        (e.get('sessionId') == sid or e.get('session_id') == sid)
        and (e.get('model') == 'test-model')
        for e in events
    )
