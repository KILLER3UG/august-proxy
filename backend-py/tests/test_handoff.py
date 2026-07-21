"""Model-switch context handoff: summarize + persist + consume-once."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.workbench import sessions as wb_sessions


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def _seed_session(messages: list[dict[str, object]]) -> str:
    session = wb_sessions.create_workbench_session(provider='anthropic')
    session.model = 'claude-old'
    session.messages = messages
    session.messageCount = len(messages)
    return session.id


def test_create_handoff_summarizes_and_persists_cursor():
    sid = _seed_session(
        [
            {'role': 'user', 'content': 'Please refactor the auth module to use JWT.'},
            {'role': 'assistant', 'content': 'Sure — I started by inspecting auth/session.py.'},
            {'role': 'user', 'content': 'Also add tests for the new flow.'},
        ]
    )

    record = wb_sessions.create_workbench_handoff(sid, from_model='claude-old', to_model='gpt-new')
    assert record is not None
    assert record['fromModel'] == 'claude-old'
    assert record['toModel'] == 'gpt-new'
    assert record['summary']
    assert record['sourceMessageRange'] == [0, 2]

    session = wb_sessions.get_workbench_session(sid)
    assert session is not None
    assert session.metadata.get('handoffCursor') == 3
    assert session.metadata.get('lastHandoff') == record


def test_second_handoff_only_covers_messages_since_cursor():
    sid = _seed_session(
        [
            {'role': 'user', 'content': 'First task.'},
            {'role': 'assistant', 'content': 'Working on first task.'},
        ]
    )
    wb_sessions.create_workbench_handoff(sid, from_model='model-a', to_model='model-b')

    session = wb_sessions.get_workbench_session(sid)
    session.messages.append({'role': 'user', 'content': 'Second task, only this should be summarized.'})
    session.messageCount = len(session.messages)

    record = wb_sessions.create_workbench_handoff(sid, from_model='model-b', to_model='model-c')
    assert record is not None
    assert record['sourceMessageRange'] == [2, 2]
    assert 'Second task' in record['summary']
    assert 'First task' not in record['summary']


def test_take_session_handoff_consumes_once():
    sid = _seed_session([{'role': 'user', 'content': 'Hello there, working on something.'}])
    wb_sessions.create_workbench_handoff(sid, from_model='model-a', to_model='model-b')

    first = wb_sessions.take_session_handoff(sid)
    assert first is not None
    second = wb_sessions.take_session_handoff(sid)
    assert second is None

    session = wb_sessions.get_workbench_session(sid)
    assert 'lastHandoff' not in (session.metadata or {})


def test_create_handoff_missing_session_returns_none():
    assert wb_sessions.create_workbench_handoff('wb_does_not_exist') is None


def test_format_session_handoff_includes_model_and_summary():
    text = wb_sessions.format_session_handoff(
        {'fromModel': 'claude-old', 'summary': 'Did some work.'}
    )
    assert 'claude-old' in text
    assert 'Did some work.' in text


@pytest.mark.asyncio
async def test_handoff_route_returns_summary(client):
    sid = _seed_session(
        [
            {'role': 'user', 'content': 'Build a login form.'},
            {'role': 'assistant', 'content': 'Added a LoginForm component.'},
        ]
    )

    resp = await client.post(
        f'/api/workbench/sessions/{sid}/handoff',
        json={'from_model': 'model-a', 'to_model': 'model-b'},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body['fromModel'] == 'model-a'
    assert body['toModel'] == 'model-b'
    assert body['summary']


@pytest.mark.asyncio
async def test_handoff_route_404_for_missing_session(client):
    resp = await client.post(
        '/api/workbench/sessions/wb_does_not_exist/handoff',
        json={'from_model': 'model-a', 'to_model': 'model-b'},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_chat_prefers_persisted_handoff_when_no_client_summary(client, monkeypatch):
    sid = _seed_session([{'role': 'user', 'content': 'Investigate the flaky test suite.'}])
    wb_sessions.create_workbench_handoff(sid, from_model='model-a', to_model='model-b')

    from app.routers import workbench as wr

    captured: dict[str, object] = {}

    async def _fake_stream(**kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(wr.wb, 'sendWorkbenchMessageStream', _fake_stream)

    resp = await client.post(
        '/api/workbench/chat',
        json={'sessionId': sid, 'message': 'continue', 'provider': 'anthropic', 'model': 'model-b'},
    )
    assert resp.status_code == 200

    task = wr._activeStreams.get(sid)
    if task is not None:
        await task
    wr._activeStreams.pop(sid, None)
    wr._cancelled.pop(sid, None)

    assert 'model-a' in str(captured.get('handoff_summary') or '')
    # Consumed — a second turn without a client summary must not resend it.
    assert wb_sessions.take_session_handoff(sid) is None
