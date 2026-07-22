"""
PTY I/O abstraction — real pseudo-terminal support for terminal sessions.

Wraps ``pty.openpty()`` (Unix) and ``pywinpty.PtyProcess`` (Windows)
behind a single async interface.

Usage
-----
    io = PtyIO()
    await io.spawn("/bin/bash")
    data = await io.read(4096)
    await io.write("ls -la\\n")
    io.resize(80, 24)
    await io.close()

On Windows, if ``pywinpty`` is not installed, the module raises
``ImportError`` with a clear message.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
from typing import Any, Optional

logger = logging.getLogger(__name__)


class PtyIO:
    """Async PTY I/O wrapper.

    Platform differences:
    - Unix: uses built-in ``pty`` module + ``os.fork()``
    - Windows: uses ``pywinpty.PtyProcess`` (optional dependency)
    """

    def __init__(self) -> None:
        self._proc: AnyProcess | None = None
        self._readerTask: asyncio.Task | None = None
        self._buffer: asyncio.Queue[bytes] = asyncio.Queue(maxsize=256)

    async def spawn(
        self,
        shell: str,
        args: Optional[list[str]] = None,
        cwd: Optional[str] = None,
        env: Optional[dict[str, str]] = None,
        cols: int = 80,
        rows: int = 24,
    ) -> None:
        """Spawn a PTY process running *shell*."""
        if platform.system() == 'Windows':
            await self._spawnWindows(shell, args or [], cwd, env, cols, rows)
        else:
            await self._spawnUnix(shell, args or [], cwd, env, cols, rows)
        self._readerTask = asyncio.create_task(self._readerLoop())

    async def read(self, n: int = 4096) -> bytes:
        """Read up to *n* bytes from the PTY.

        Blocks until data is available. Returns empty bytes on EOF.
        """
        if self._proc is None and self._buffer.empty():
            return b''
        try:
            data = await asyncio.wait_for(self._buffer.get(), timeout=60.0)
            return data
        except asyncio.TimeoutError:
            return b''

    async def write(self, data: bytes | str) -> None:
        """Write data to the PTY."""
        if self._proc is None:
            return
        if isinstance(data, str):
            data = data.encode('utf-8', errors='replace')
        self._write(data)

    def resize(self, cols: int, rows: int) -> None:
        """Resize the PTY terminal."""
        if self._proc is None:
            return
        cols = max(20, min(cols, 240))
        rows = max(5, min(rows, 120))
        self._resize(cols, rows)

    async def close(self) -> None:
        """Close the PTY and clean up."""
        if self._readerTask:
            self._readerTask.cancel()
            try:
                await self._readerTask
            except (asyncio.CancelledError, Exception):
                pass
            self._readerTask = None
        self._close()
        self._proc = None

    @property
    def isOpen(self) -> bool:
        return self._proc is not None

    async def _spawnUnix(
        self, shell: str, args: list[str], cwd: Optional[str], env: Optional[dict[str, str]], cols: int, rows: int
    ) -> None:
        import fcntl
        import pty
        import struct
        import termios

        pid, fd = getattr(pty, 'fork')()
        if pid == 0:
            if cwd:
                os.chdir(cwd)
            if env:
                os.environ.update(env)
            os.execvp(shell, [shell, *args])
            os._exit(1)
        if cols and rows:
            try:
                buf = struct.pack('HHHH', rows, cols, 0, 0)
                getattr(fcntl, 'ioctl')(fd, getattr(termios, 'TIOCSWINSZ'), buf)
            except Exception:
                pass
        self._proc = _UnixPtyProcess(pid=pid, fd=fd)

    def _writeUnix(self, data: bytes) -> None:
        if self._proc and isinstance(self._proc, _UnixPtyProcess):
            os.write(self._proc.fd, data)

    def _resizeUnix(self, cols: int, rows: int) -> None:
        import fcntl
        import struct
        import termios

        if self._proc and isinstance(self._proc, _UnixPtyProcess):
            try:
                buf = struct.pack('HHHH', rows, cols, 0, 0)
                getattr(fcntl, 'ioctl')(self._proc.fd, getattr(termios, 'TIOCSWINSZ'), buf)
            except Exception:
                pass

    def _closeUnix(self) -> None:
        if self._proc and isinstance(self._proc, _UnixPtyProcess):
            try:
                os.close(self._proc.fd)
            except OSError:
                pass
            try:
                os.waitpid(self._proc.pid, 0)
            except OSError:
                pass

    async def _spawnWindows(
        self, shell: str, args: list[str], cwd: Optional[str], env: Optional[dict[str, str]], cols: int, rows: int
    ) -> None:
        # Package name on PyPI is ``pywinpty``; import module is ``winpty``.
        PtyProcess = None
        try:
            from winpty import PtyProcess as _P  # type: ignore[import-untyped,import-not-found]
            PtyProcess = _P
        except ImportError:
            try:
                from pywinpty import PtyProcess as _P  # older / alternate layout
                PtyProcess = _P
            except ImportError as exc:
                raise ImportError(
                    'pywinpty is required for PTY support on Windows. '
                    'Install with: pip install pywinpty>=2.0.0'
                ) from exc
        argv = [shell, *args]
        proc = PtyProcess.spawn(
            argv,
            cwd=cwd or os.getcwd(),
            env=env,
            dimensions=(rows, cols),  # (rows, cols) per winpty API
        )
        self._proc = _WinPtyProcess(proc=proc)

    def _writeWindows(self, data: bytes) -> None:
        if self._proc and isinstance(self._proc, _WinPtyProcess):
            self._proc.proc.write(data.decode('utf-8', errors='replace'))

    def _resizeWindows(self, cols: int, rows: int) -> None:
        if self._proc and isinstance(self._proc, _WinPtyProcess):
            try:
                self._proc.proc.setwinsize(rows, cols)
            except Exception:
                pass

    def _closeWindows(self) -> None:
        if self._proc and isinstance(self._proc, _WinPtyProcess):
            try:
                self._proc.proc.terminate()
            except Exception:
                pass

    def _write(self, data: bytes) -> None:
        if platform.system() == 'Windows':
            self._writeWindows(data)
        else:
            self._writeUnix(data)

    def _resize(self, cols: int, rows: int) -> None:
        if platform.system() == 'Windows':
            self._resizeWindows(cols, rows)
        else:
            self._resizeUnix(cols, rows)

    def _close(self) -> None:
        if platform.system() == 'Windows':
            self._closeWindows()
        else:
            self._closeUnix()

    async def _readerLoop(self) -> None:
        """Read from the PTY in a loop, pushing data into the buffer.

        Empty reads are idle polls (especially on Windows winpty timeouts) —
        only exit when the process is gone or a hard EOF/error occurs.
        """
        try:
            while self._proc:
                alive = True
                if platform.system() == 'Windows' and isinstance(self._proc, _WinPtyProcess):
                    try:
                        alive = bool(self._proc.proc.isalive())
                    except Exception:
                        alive = False
                if platform.system() == 'Windows':
                    data = await self._readWindows()
                else:
                    data = await self._readUnix()
                if data:
                    try:
                        await self._buffer.put(data)
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        # Drop if queue is full / closed
                        pass
                    continue
                # No data this poll
                if not alive:
                    break
                await asyncio.sleep(0.02)
        except Exception:
            logger.exception('[PtyIO] reader loop error')
        finally:
            # Signal EOF to any waiting readers
            try:
                self._buffer.put_nowait(b'')
            except Exception:
                pass
            await self.close()

    async def _readUnix(self) -> bytes:
        if not self._proc or not isinstance(self._proc, _UnixPtyProcess):
            return b''
        import select

        loop = asyncio.get_running_loop()

        def _read():
            r, __, __ = select.select([self._proc.fd], [], [], 0.1)
            if r:
                return os.read(self._proc.fd, 4096)
            return b''

        return await loop.run_in_executor(None, _read)

    async def _readWindows(self) -> bytes:
        if not self._proc or not isinstance(self._proc, _WinPtyProcess):
            return b''
        loop = asyncio.get_running_loop()
        proc = self._proc.proc

        def _read():
            try:
                # winpty PtyProcess.read(size) blocks until data or EOF (no timeout kw).
                data = proc.read(4096)
                if not data:
                    return b''
                if isinstance(data, str):
                    return data.encode('utf-8', errors='replace')
                return bytes(data)
            except EOFError:
                return b''
            except Exception as exc:
                logger.debug('[PtyIO] winpty read: %s', exc)
                return b''

        return await loop.run_in_executor(None, _read)


class _UnixPtyProcess:
    """Container for Unix PTY process state."""

    def __init__(self, pid: int, fd: int) -> None:
        self.pid = pid
        self.fd = fd


class _WinPtyProcess:
    """Container for Windows PTY process state."""

    def __init__(self, proc: Any) -> None:
        # proc type is platform-specific (Windows process handle / pipe).
        # A Protocol covering the union is possible but adds abstraction
        # overhead for a single wrapper — keep Any with this note.
        self.proc: Any = proc


AnyProcess = object
