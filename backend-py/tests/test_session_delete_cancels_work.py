"""Session delete must detach watchers and cancel in-flight work.

Covers: environment-watcher detach on delete (#1), service-layer work
cancellation (orchestrator tasks, spawn watchers) via cancel_session_work,
and the router deleteSession handler cancelling live chat-turn tasks (#2).
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from app.services.workbench.sessions import (
    cancel_session_work,
    create_workbench_session,
    delete_workbench_session,
    get_workbench_session,
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


def test_delete_detaches_session_watcher():
    """Deleting a session stops + removes its environment watcher."""
    import app.services.cognitive_boot as cb

    s = create_workbench_session(provider='test')
    fake = MagicMock()
    cb._session_watchers[s.id] = fake
    try:
        assert delete_workbench_session(s.id) is True
        assert s.id not in cb._session_watchers
        fake.stop.assert_called_once()
    finally:
        cb._session_watchers.pop(s.id, None)


def test_delete_without_watcher_is_safe():
    """Deleting a session that never had a watcher is an idempotent no-op."""
    s = create_workbench_session(provider='test')
    assert delete_workbench_session(s.id) is True
    assert get_workbench_session(s.id) is None


@pytest.mark.asyncio
async def test_cancel_session_work_cancels_orchestrator_tasks(monkeypatch):
    """cancel_session_work cancels orchestrator tasks for the session."""
    from app.services.agent_message_bus import AgentMessageBus
    from app.services.subagent_orchestrator import SubagentHandle, SubagentOrchestrator

    orch = SubagentOrchestrator(AgentMessageBus(), max_workers=5)

    async def hang() -> None:
        await asyncio.Event().wait()

    handle = SubagentHandle('task_x', 'general', 'goal', sessionId='wb_sess_1')
    orch._handles['task_x'] = handle
    orch._tasks['task_x'] = asyncio.create_task(hang())
    monkeypatch.setattr('app.services.runtime_services.get_orchestrator', lambda *a, **k: orch)

    cancel_session_work('wb_sess_1')
    assert orch._tasks.get('task_x') is None
    assert handle.status == 'cancelled'
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_cancel_session_work_cancels_spawn_watches(monkeypatch):
    """cancel_session_work cancels background spawn_subagents watchers."""
    from app.services.tools import spawn_subagents_tool as sst

    async def hang() -> None:
        await asyncio.Event().wait()

    t = asyncio.create_task(hang())
    sst._session_watch_tasks['wb_sess_2'] = {t}
    monkeypatch.setattr('app.services.runtime_services.get_orchestrator', lambda *a, **k: None)

    cancel_session_work('wb_sess_2')
    await asyncio.sleep(0)
    assert t.cancelled()
    assert sst._session_watch_tasks.get('wb_sess_2') in (None, set())


@pytest.mark.asyncio
async def test_router_delete_cancels_active_stream():
    """DELETE /api/workbench/sessions/{id} cancels the live turn + cancel event."""
    from app.main import app
    from app.routers import workbench as wr
    from httpx import ASGITransport, AsyncClient

    s = create_workbench_session(provider='test')
    sid = s.id

    async def hang() -> None:
        await asyncio.Event().wait()

    task = asyncio.create_task(hang())
    cancel = asyncio.Event()
    wr._activeStreams[sid] = task
    wr._cancelled[sid] = cancel

    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url='http://test') as ac:
            resp = await ac.delete(f'/api/workbench/sessions/{sid}')
    finally:
        wr._activeStreams.pop(sid, None)
        wr._cancelled.pop(sid, None)

    assert resp.status_code == 200
    assert cancel.is_set()
    assert wr._activeStreams.get(sid) is None
    assert get_workbench_session(sid) is None
    assert task.cancelled() or task.done()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
