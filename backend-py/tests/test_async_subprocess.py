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
