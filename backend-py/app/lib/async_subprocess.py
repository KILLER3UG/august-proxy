"""Windows-safe asyncio subprocess teardown.

On Windows ProactorEventLoop, killing a subprocess without closing stdin and
awaiting ``wait()`` leaves pipe transports unclosed. Their ``__del__`` then
raises ``ValueError: I/O operation on closed pipe`` while formatting a
ResourceWarning — noisy and can trip process exit during shutdown.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from contextvars import ContextVar
from typing import Any


class SubprocessAborted(Exception):
    """Raised when a child is killed due to timeout or cancel."""

    def __init__(self, reason: str) -> None:
        self.reason = reason  # 'timeout' | 'cancelled'
        super().__init__(reason)


# Set by the workbench tool loop so long-running agent shell commands can be
# interrupted when the user hits Stop — without threading the Event through
# every sandbox backend signature.
current_subprocess_cancel: ContextVar[asyncio.Event | None] = ContextVar(
    'subprocess_cancel', default=None
)


def noninteractive_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Env that discourages pagers, prompts, and interactive CLIs."""
    env = dict(base if base is not None else os.environ)
    env.update(
        {
            'CI': '1',
            'TERM': 'dumb',
            'NO_COLOR': '1',
            'GIT_TERMINAL_PROMPT': '0',
            'GIT_PAGER': 'cat',
            'PAGER': 'cat',
            'LESS': 'FRX',
            'PYTHONUNBUFFERED': '1',
            'NPM_CONFIG_PROGRESS': 'false',
            'NPM_CONFIG_FUND': 'false',
            'NPM_CONFIG_AUDIT': 'false',
            'DEBIAN_FRONTEND': 'noninteractive',
        }
    )
    return env


def agent_subprocess_kwargs(*, cwd: str | None = None) -> dict[str, Any]:
    """Kwargs for one-shot agent shell spawns (no TTY, no inherited stdin)."""
    kwargs: dict[str, Any] = {
        'stdout': asyncio.subprocess.PIPE,
        'stderr': asyncio.subprocess.PIPE,
        'stdin': asyncio.subprocess.DEVNULL,
        'cwd': cwd or None,
        'env': noninteractive_env(),
    }
    if os.name == 'nt':
        # Avoid flashing console windows behind the desktop app.
        kwargs['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000)
    return kwargs


async def close_process(
    proc: asyncio.subprocess.Process | None,
    *,
    grace: float = 5.0,
    kill_grace: float = 2.0,
) -> None:
    """Terminate *proc* and drain/close its pipe transports."""
    if proc is None:
        return

    # Prefer a clean EOF on stdin so well-behaved children exit themselves.
    stdin = proc.stdin
    if stdin is not None:
        try:
            stdin.close()
            await asyncio.wait_for(stdin.wait_closed(), timeout=1.0)
        except Exception:
            pass

    if proc.returncode is None:
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=grace)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=kill_grace)
            except (asyncio.TimeoutError, ProcessLookupError, asyncio.CancelledError):
                pass

    # Drop StreamReader refs so transports can be GC'd after wait().
    for attr in ('stdin', 'stdout', 'stderr'):
        try:
            setattr(proc, attr, None)
        except Exception:
            pass


async def communicate_or_kill(
    proc: asyncio.subprocess.Process,
    *,
    timeout: float,
    cancel: asyncio.Event | None = None,
) -> tuple[bytes, bytes]:
    """Like ``proc.communicate()``, but kill + close on timeout or cancel.

    When *cancel* is omitted, uses ``current_subprocess_cancel`` if set
    (workbench Stop button). Raises ``SubprocessAborted`` with reason
    ``timeout`` or ``cancelled`` after the child is killed.
    """
    if cancel is None:
        cancel = current_subprocess_cancel.get()

    communicate_task = asyncio.create_task(proc.communicate())
    timeout_task: asyncio.Task[None] | None = None
    cancel_task: asyncio.Task[bool] | None = None
    waiters: list[asyncio.Task[Any]] = [communicate_task]

    try:
        if timeout is not None and timeout > 0:
            timeout_task = asyncio.create_task(asyncio.sleep(timeout))
            waiters.append(timeout_task)
        if cancel is not None:
            cancel_task = asyncio.create_task(cancel.wait())
            waiters.append(cancel_task)

        done, _pending = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)

        if communicate_task in done:
            return communicate_task.result()

        await close_process(proc, grace=1.0, kill_grace=1.0)
        if cancel_task is not None and cancel_task in done:
            raise SubprocessAborted('cancelled')
        raise SubprocessAborted('timeout')
    finally:
        for task in (timeout_task, cancel_task):
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        if not communicate_task.done():
            communicate_task.cancel()
            try:
                await communicate_task
            except (asyncio.CancelledError, Exception):
                pass
        elif communicate_task.cancelled():
            pass
        else:
            # Drain result if somehow completed after kill to avoid "task exception was never retrieved"
            try:
                communicate_task.result()
            except Exception:
                pass


async def close_processes(procs: list[Any]) -> None:
    """Close many processes concurrently (best-effort)."""
    if not procs:
        return
    await asyncio.gather(*(close_process(p) for p in procs), return_exceptions=True)
