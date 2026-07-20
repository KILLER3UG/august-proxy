"""Tests for Windows-safe asyncio subprocess teardown."""

from __future__ import annotations

import asyncio
import sys

import pytest

from app.lib.async_subprocess import close_process, communicate_or_kill


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
    )
    with pytest.raises(asyncio.TimeoutError):
        await communicate_or_kill(proc, timeout=0.2)
    assert proc.returncode is not None
