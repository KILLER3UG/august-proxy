"""Terminal service: exited-session reaping and safe macOS workdir quoting."""

from __future__ import annotations

import asyncio
import time

import pytest
from app.services.workbench import terminal_service as ts


@pytest.fixture(autouse=True)
def _clean_sessions():
    ts._sessions.clear()
    yield
    ts._sessions.clear()


def _mk_session(sid: str, status: str, exited_at: float | None, updated: str = 'x') -> dict:
    s = {'id': sid, 'title': 'T', 'cwd': '/tmp', 'command': 'bash', 'status': status, 'buffer': ''}
    s['updatedAt'] = updated
    if exited_at is not None:
        s['exitedAt'] = exited_at
    return s


@pytest.mark.asyncio
async def test_reap_exits_sessions_after_grace(monkeypatch):
    closed: list[str] = []

    async def fake_close(sid: str) -> bool:
        closed.append(sid)
        ts._sessions.pop(sid, None)
        return True

    monkeypatch.setattr(ts, 'closeTerminalSession', fake_close)
    now = time.monotonic()
    ts._sessions['term_old'] = _mk_session('term_old', 'exited', now - 120)
    ts._sessions['term_new'] = _mk_session('term_new', 'exited', now - 5)
    ts._sessions['term_run'] = _mk_session('term_run', 'running', None)

    reaped = await ts.reapTerminalSessions()
    assert reaped == 1
    assert closed == ['term_old']
    assert 'term_old' not in ts._sessions
    assert 'term_new' in ts._sessions
    assert 'term_run' in ts._sessions


@pytest.mark.asyncio
async def test_hard_cap_evicts_oldest_exited_first(monkeypatch):
    closed: list[str] = []

    async def fake_close(sid: str) -> bool:
        closed.append(sid)
        ts._sessions.pop(sid, None)
        return True

    monkeypatch.setattr(ts, 'closeTerminalSession', fake_close)
    monkeypatch.setattr(ts, '_MAX_SESSIONS_HARD', 2)
    now = time.monotonic()
    ts._sessions['term_a'] = _mk_session('term_a', 'exited', now - 10)
    ts._sessions['term_b'] = _mk_session('term_b', 'running', None, updated='2026-01-01T00:00:00Z')
    ts._sessions['term_c'] = _mk_session('term_c', 'running', None, updated='2026-01-03T00:00:00Z')
    ts._sessions['term_d'] = _mk_session('term_d', 'running', None, updated='2026-01-04T00:00:00Z')

    reaped = await ts.reapTerminalSessions()
    assert reaped == 2
    assert set(closed) == {'term_a', 'term_b'}
    assert 'term_c' in ts._sessions
    assert 'term_d' in ts._sessions


def test_open_external_terminal_quotes_macos_workdir(monkeypatch):
    """The workspace path must be shell-quoted, not interpolated raw."""
    import subprocess

    calls: list[list[str]] = []
    monkeypatch.setattr(ts.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(ts.os.path, 'isdir', lambda p: True)
    monkeypatch.setattr(ts, '_getShell', lambda: '/bin/zsh')
    monkeypatch.setattr(subprocess, 'Popen', lambda args, **kw: calls.append(args))

    result = ts.openExternalTerminal(cwd='/tmp/a"quote$(touch /tmp/pwn)')
    assert result.get('ok') is True
    script = calls[0][-1]
    # The path is fed through `quoted form of` (POSIX single-quote), never
    # spliced directly into the `do script "cd ..."` shell string.
    assert 'quoted form of' in script
    assert 'do script "cd /tmp/a' not in script
