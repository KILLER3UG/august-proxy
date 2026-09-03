"""Tests for Windows-safe asyncio subprocess teardown."""

from __future__ import annotations

import asyncio
import sys

import pytest
from app.lib.async_subprocess import (
    SubprocessAborted,
    close_process,
    communicate_or_kill,
    current_command_output,
    current_subprocess_cancel,
    prefix_line_buffering,
)


@pytest.mark.asyncio
async def test_close_process_terminates_child() -> None:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        '-c',
        'import time; time.sleep(30)',
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.PIPE,
    )
    assert proc.returncode is None
    await close_process(proc, grace=2.0, kill_grace=1.0)
    assert proc.returncode is not None


@pytest.mark.asyncio
async def test_communicate_or_kill_on_timeout() -> None:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        '-c',
        'import time; time.sleep(30)',
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
    )
    with pytest.raises(SubprocessAborted) as excinfo:
        await communicate_or_kill(proc, timeout=0.2)
    assert excinfo.value.reason == 'timeout'
    assert proc.returncode is not None


@pytest.mark.asyncio
async def test_communicate_streaming_emits_chunks() -> None:
    chunks: list[str] = []

    async def _on(text: str) -> None:
        chunks.append(text)

    token = current_command_output.set(_on)
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            '-u',
            '-c',
            'print("hello-stream", flush=True); print("world-stream", flush=True)',
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
        out, _err = await communicate_or_kill(proc, timeout=10)
        assert b'hello-stream' in out
        assert any('hello-stream' in c for c in chunks)
    finally:
        current_command_output.reset(token)


@pytest.mark.asyncio
async def test_communicate_or_kill_on_cancel() -> None:
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        '-c',
        'import time; time.sleep(30)',
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
    )
    cancel = asyncio.Event()
    token = current_subprocess_cancel.set(cancel)

    async def _fire() -> None:
        await asyncio.sleep(0.1)
        cancel.set()

    fire = asyncio.create_task(_fire())
    try:
        with pytest.raises(SubprocessAborted) as excinfo:
            await communicate_or_kill(proc, timeout=30)
        assert excinfo.value.reason == 'cancelled'
        assert proc.returncode is not None
    finally:
        current_subprocess_cancel.reset(token)
        fire.cancel()


@pytest.mark.asyncio
async def test_outer_task_cancel_kills_child() -> None:
    """Cancelling the *outer* task (chat Stop) must kill the child process,
    not just abandon it — otherwise the orphan keeps running until its own
    sleep ends (orphan race regression guard)."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        '-c',
        'import time; time.sleep(30)',
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
    )
    task = asyncio.create_task(communicate_or_kill(proc, timeout=30))
    await asyncio.sleep(0.1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # close_process ran during cancellation handling — the child is gone.
    assert proc.returncode is not None


def _with_platform(monkeypatch: pytest.MonkeyPatch, name: str, stdbuf: str | None) -> None:
    """Point the module's ``os`` binding at a platform shim.

    Patching the real ``os.name`` would break pytest internals (pathlib
    refuses to instantiate PosixPath on Windows), so the module's os reference
    is swapped instead — only ``prefix_line_buffering`` reads it here.
    """
    import types

    from app.lib import async_subprocess as asp

    monkeypatch.setattr(asp, 'os', types.SimpleNamespace(name=name))
    monkeypatch.setattr('shutil.which', lambda _n: stdbuf)


def test_prefix_line_buffering_applies_to_simple_external_commands(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _with_platform(monkeypatch, 'posix', '/usr/bin/stdbuf')
    assert prefix_line_buffering('npm install --omit=dev') == 'stdbuf -oL -eL npm install --omit=dev'
    assert prefix_line_buffering('make -j4') == 'stdbuf -oL -eL make -j4'
    # Compound lines still work — stdbuf wraps the first external command.
    assert prefix_line_buffering('make && make install').startswith('stdbuf -oL -eL make')


def test_prefix_line_buffering_skips_builtins_and_assignments(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _with_platform(monkeypatch, 'posix', '/usr/bin/stdbuf')
    # Shell builtins have no external binary for stdbuf to exec.
    assert prefix_line_buffering('cd frontend && npm run build') == 'cd frontend && npm run build'
    assert prefix_line_buffering('export FOO=1') == 'export FOO=1'
    assert prefix_line_buffering('for f in *; do echo "$f"; done') == 'for f in *; do echo "$f"; done'
    # Assignment prefixes and quoted program names would break the wrap.
    assert prefix_line_buffering('FOO=1 make') == 'FOO=1 make'
    assert prefix_line_buffering('"my tool" --version') == '"my tool" --version'


def test_prefix_line_buffering_unavailable_platforms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Windows: no coreutils semantics — never wrapped.
    _with_platform(monkeypatch, 'nt', '/usr/bin/stdbuf')
    assert prefix_line_buffering('npm install') == 'npm install'
    # macOS / minimal hosts without stdbuf: unchanged.
    _with_platform(monkeypatch, 'posix', None)
    assert prefix_line_buffering('npm install') == 'npm install'
    assert prefix_line_buffering('') == ''


def test_noninteractive_env_scrubs_august_prefix_and_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """P3.2 audit fix: the AUGUST_* prefix branch must scrub FULL AUGUST_
    variable names (AUGUST_BRAIN_SQLITE_FILE / AUGUST_DATA_DIR), not just the
    exact literal `AUGUST_` — the old double-anchored pattern leaked the
    data-root pointers into every agent child process."""
    from app.lib.async_subprocess import noninteractive_env

    monkeypatch.setenv('AUGUST_BRAIN_SQLITE_FILE', 'x')
    monkeypatch.setenv('AUGUST_DATA_DIR', 'y')
    monkeypatch.setenv('MYPROVIDER_API_KEY', 'key-123')
    monkeypatch.setenv('SOME_TOKEN', 't')
    monkeypatch.setenv('UNRELATED_VAR', 'keep-me')
    env = noninteractive_env()
    assert 'AUGUST_BRAIN_SQLITE_FILE' not in env
    assert 'AUGUST_DATA_DIR' not in env
    assert 'MYPROVIDER_API_KEY' not in env
    assert 'SOME_TOKEN' not in env
    # Benign vars survive; noninteractive flags ride along.
    assert env['UNRELATED_VAR'] == 'keep-me'
    assert env['PYTHONUNBUFFERED'] == '1'
