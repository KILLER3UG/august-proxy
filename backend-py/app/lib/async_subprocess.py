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
import time
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

# Optional live stdout/stderr callback for agent shell (SSE tool_progress).
# Signature: async or sync callable taking the decoded text chunk.
current_command_output: ContextVar[Any] = ContextVar('command_output', default=None)


def noninteractive_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Env that discourages pagers/prompts but keeps download progress visible."""
    env = dict(base if base is not None else os.environ)
    env.update(
        {
            'TERM': 'dumb',
            'NO_COLOR': '1',
            'GIT_TERMINAL_PROMPT': '0',
            'GIT_PAGER': 'cat',
            'PAGER': 'cat',
            'LESS': 'FRX',
            'PYTHONUNBUFFERED': '1',
            # Keep progress lines (pip/npm) so the chat UI can stream them.
            'PIP_PROGRESS_BAR': 'on',
            'PIP_DISABLE_PIP_VERSION_CHECK': '1',
            'NPM_CONFIG_PROGRESS': 'true',
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

    When ``current_command_output`` is set, streams decoded chunks to that
    callback while waiting (so the UI can show live download progress).
    """
    on_output = current_command_output.get()
    if on_output is not None and proc.stdout is not None and proc.stderr is not None:
        return await _communicate_streaming(
            proc, timeout=timeout, cancel=cancel, on_output=on_output
        )

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
            try:
                communicate_task.result()
            except Exception:
                pass


async def _emit_output(on_output: Any, text: str) -> None:
    if not text or on_output is None:
        return
    try:
        result = on_output(text)
        if asyncio.iscoroutine(result):
            await result
    except Exception:
        pass


async def _communicate_streaming(
    proc: asyncio.subprocess.Process,
    *,
    timeout: float,
    cancel: asyncio.Event | None,
    on_output: Any,
) -> tuple[bytes, bytes]:
    """Read stdout/stderr concurrently, emit text chunks, honor timeout/cancel."""
    if cancel is None:
        cancel = current_subprocess_cancel.get()

    stdout_buf = bytearray()
    stderr_buf = bytearray()
    # Coalesce tiny reads so SSE is not flooded (still feels live).
    pending = ''
    last_flush = time.monotonic()
    FLUSH_INTERVAL = 0.12
    FLUSH_CHARS = 200

    async def _flush(force: bool = False) -> None:
        nonlocal pending, last_flush
        if not pending:
            return
        now = time.monotonic()
        if not force and len(pending) < FLUSH_CHARS and (now - last_flush) < FLUSH_INTERVAL:
            return
        chunk, pending = pending, ''
        last_flush = now
        await _emit_output(on_output, chunk)

    async def _read_stream(reader: asyncio.StreamReader, into: bytearray) -> None:
        nonlocal pending
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                break
            into.extend(chunk)
            text = chunk.decode('utf-8', errors='replace')
            pending += text
            await _flush(False)

    stdout = proc.stdout
    stderr = proc.stderr
    assert stdout is not None and stderr is not None

    readers = [
        asyncio.create_task(_read_stream(stdout, stdout_buf)),
        asyncio.create_task(_read_stream(stderr, stderr_buf)),
    ]
    gather_task = asyncio.gather(*readers)
    timeout_task: asyncio.Task[None] | None = None
    cancel_task: asyncio.Task[bool] | None = None
    waiters: list[asyncio.Task[Any]] = [gather_task]

    try:
        if timeout is not None and timeout > 0:
            timeout_task = asyncio.create_task(asyncio.sleep(timeout))
            waiters.append(timeout_task)
        if cancel is not None:
            cancel_task = asyncio.create_task(cancel.wait())
            waiters.append(cancel_task)

        done, _pending = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)

        if gather_task in done:
            gather_task.result()
            await _flush(True)
            await proc.wait()
            return (bytes(stdout_buf), bytes(stderr_buf))

        await close_process(proc, grace=1.0, kill_grace=1.0)
        await _flush(True)
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
        if not gather_task.done():
            for t in readers:
                t.cancel()
            gather_task.cancel()
            try:
                await gather_task
            except (asyncio.CancelledError, Exception):
                pass


async def close_processes(procs: list[Any]) -> None:
    """Close many processes concurrently (best-effort)."""
    if not procs:
        return
    await asyncio.gather(*(close_process(p) for p in procs), return_exceptions=True)
