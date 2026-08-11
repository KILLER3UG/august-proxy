"""POST /api/terminal/command must accept a sessionId and bind the command
to the workbench session's workspace cwd."""

from __future__ import annotations

import pytest
from app.main import app
from app.routers.terminal_routes import CommandBody
from httpx import ASGITransport, AsyncClient


def test_command_body_accepts_session_id():
    body = CommandBody.model_validate({'command': 'ls', 'sessionId': 'wb_1'})
    assert body.session_id == 'wb_1'
    assert body.model_dump(by_alias=True)['sessionId'] == 'wb_1'


@pytest.mark.asyncio
async def test_submit_command_uses_session_cwd(monkeypatch, tmp_path):
    """sessionId → command runs in the session's workspacePath."""
    import app.lib.async_subprocess as asub
    from app.services.workbench import terminal_service as ts
    from app.services.workbench.sessions import create_workbench_session

    s = create_workbench_session(provider='test')
    s.workspacePath = str(tmp_path)

    captured: dict = {}

    async def fake_subprocess_shell(command, **kwargs):
        captured['command'] = command
        captured['cwd'] = kwargs.get('cwd')
        proc = type('P', (), {'returncode': 0})()
        return proc

    monkeypatch.setattr(ts.asyncio, 'create_subprocess_shell', fake_subprocess_shell)

    async def fake_communicate(proc, **kw):
        return b'ok\n', b''

    monkeypatch.setattr(asub, 'communicate_or_kill', fake_communicate)
    result = await ts.submitTerminalCommand({'command': 'pwd', 'sessionId': s.id, 'approved': True})
    assert result.get('status') == 'completed'
    assert captured['cwd'] == str(tmp_path)


@pytest.mark.asyncio
async def test_submit_command_falls_back_to_getcwd_without_session(monkeypatch):
    """No sessionId → previous behavior (process cwd) is preserved."""
    import os

    import app.lib.async_subprocess as asub
    from app.services.workbench import terminal_service as ts

    captured: dict = {}

    async def fake_subprocess_shell(command, **kwargs):
        captured['cwd'] = kwargs.get('cwd')
        proc = type('P', (), {'returncode': 0})()
        return proc

    monkeypatch.setattr(ts.asyncio, 'create_subprocess_shell', fake_subprocess_shell)

    async def fake_communicate(proc, **kw):
        return b'ok\n', b''

    monkeypatch.setattr(asub, 'communicate_or_kill', fake_communicate)
    await ts.submitTerminalCommand({'command': 'pwd', 'approved': True})
    assert captured['cwd'] == os.getcwd()


@pytest.mark.asyncio
async def test_post_command_route_accepts_session_id(monkeypatch):
    """The route serializes sessionId through the body and service."""
    import os

    import app.lib.async_subprocess as asub
    from app.services.workbench import terminal_service as ts

    captured: dict = {}

    async def fake_subprocess_shell(command, **kwargs):
        captured['cwd'] = kwargs.get('cwd')
        proc = type('P', (), {'returncode': 0})()
        return proc

    monkeypatch.setattr(ts.asyncio, 'create_subprocess_shell', fake_subprocess_shell)

    async def fake_communicate(proc, **kw):
        return b'ok\n', b''

    monkeypatch.setattr(asub, 'communicate_or_kill', fake_communicate)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        resp = await ac.post(
            '/api/terminal/command',
            json={'command': 'pwd', 'sessionId': 'wb_missing_session', 'approved': True},
        )
    assert resp.status_code == 200
    # Session does not exist → fall back to process cwd (no crash).
    assert captured['cwd'] == os.getcwd()
