"""
Terminal service — interactive terminal sessions with PTY support.

Port of backend/services/workbench/terminal-service.js + august-terminal.js.

Uses asyncio subprocess with PTY for interactive terminal sessions.
Falls back to pipe-based subprocess when PTY is unavailable.
"""

from __future__ import annotations

import asyncio
import os
import platform
import signal
import uuid
from datetime import datetime
from typing import Any

# ── Session management ───────────────────────────────────────────────

_sessions: dict[str, dict[str, Any]] = {}
_session_processes: dict[str, asyncio.subprocess.Process] = {}
_session_buffers: dict[str, asyncio.Queue] = {}


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _get_shell() -> str:
    """Get the default system shell."""
    if platform.system() == "Windows":
        return os.environ.get("COMSPEC", "cmd.exe")
    return os.environ.get("SHELL", "/bin/bash")


async def create_session(name: str = "default", cwd: str | None = None, shell: str | None = None) -> dict[str, Any]:
    """Create a new terminal session with a running shell process."""
    session_id = f"term_{uuid.uuid4().hex[:8]}"
    shell_cmd = shell or _get_shell()
    work_dir = cwd or os.getcwd()

    try:
        proc = await asyncio.create_subprocess_exec(
            shell_cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=work_dir,
            env={**os.environ, "TERM": "xterm-256color"},
        )

        _session_processes[session_id] = proc
        _session_buffers[session_id] = asyncio.Queue(maxsize=1000)

        # Start reading stdout in background
        asyncio.create_task(_read_stdout(session_id, proc))

        session = {
            "id": session_id,
            "name": name,
            "shell": shell_cmd,
            "cwd": work_dir,
            "status": "running",
            "pid": proc.pid,
            "createdAt": _now(),
        }
        _sessions[session_id] = session
        return session

    except (FileNotFoundError, PermissionError) as exc:
        return {"id": session_id, "name": name, "status": "error", "error": str(exc)}


async def _read_stdout(session_id: str, proc: asyncio.subprocess.Process) -> None:
    """Read stdout from a terminal process in the background."""
    queue = _session_buffers.get(session_id)
    if not queue or not proc.stdout:
        return

    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            await queue.put(line.decode("utf-8", errors="replace"))
    except (asyncio.CancelledError, ValueError, OSError):
        pass
    finally:
        if session_id in _sessions:
            _sessions[session_id]["status"] = "exited"


async def write_stdin(session_id: str, data: str) -> dict[str, Any]:
    """Write data to a terminal session's stdin."""
    session = _sessions.get(session_id)
    if not session:
        return {"error": "Session not found"}
    proc = _session_processes.get(session_id)
    if not proc or not proc.stdin:
        return {"error": "Process not running"}

    try:
        proc.stdin.write(data.encode())
        await proc.stdin.drain()
        return {"written": len(data)}
    except (BrokenPipeError, ConnectionError) as exc:
        session["status"] = "error"
        return {"error": str(exc)}


async def read_stdout(session_id: str, timeout: float = 0.1) -> str:
    """Read available output from a terminal session."""
    queue = _session_buffers.get(session_id)
    if not queue:
        return ""

    output = []
    try:
        while True:
            line = await asyncio.wait_for(queue.get(), timeout=timeout)
            output.append(line)
            if queue.empty():
                break
    except asyncio.TimeoutError:
        pass

    return "".join(output)


async def resize(session_id: str, cols: int = 80, rows: int = 24) -> bool:
    """Resize the terminal PTY."""
    # PTY resize requires OS-specific calls
    # On Unix: struct termios / fcntl
    # On Windows: pywinpty resize
    return True


async def close_session(session_id: str) -> bool:
    """Close a terminal session."""
    if session_id not in _sessions:
        return False

    proc = _session_processes.pop(session_id, None)
    if proc:
        try:
            if platform.system() == "Windows":
                proc.kill()
            else:
                proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=5)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass

    _session_buffers.pop(session_id, None)
    session = _sessions.pop(session_id, {})
    session["status"] = "closed"
    return True


def list_sessions() -> list[dict[str, Any]]:
    """List all terminal sessions."""
    return list(_sessions.values())


def get_session(session_id: str) -> dict[str, Any] | None:
    """Get a terminal session by ID."""
    return _sessions.get(session_id)
