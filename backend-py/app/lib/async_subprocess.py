"""Windows-safe asyncio subprocess teardown.

On Windows ProactorEventLoop, killing a subprocess without closing stdin and
awaiting ``wait()`` leaves pipe transports unclosed. Their ``__del__`` then
raises ``ValueError: I/O operation on closed pipe`` while formatting a
ResourceWarning — noisy and can trip process exit during shutdown.
"""

from __future__ import annotations

import asyncio
from typing import Any


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
) -> tuple[bytes, bytes]:
    """Like ``proc.communicate()``, but kill + close on timeout."""
    try:
        return await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        await close_process(proc, grace=1.0, kill_grace=1.0)
        raise


async def close_processes(procs: list[Any]) -> None:
    """Close many processes concurrently (best-effort)."""
    if not procs:
        return
    await asyncio.gather(*(close_process(p) for p in procs), return_exceptions=True)
