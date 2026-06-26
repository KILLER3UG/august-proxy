"""
Terminal service — interactive terminal sessions with PTY/stdin support.

Port of backend/services/workbench/terminal-service.js.
Supports the /ui/terminal/* REST API + WebSocket live I/O.
"""

from __future__ import annotations

import asyncio
import os
import platform
import uuid
from collections import deque
from datetime import datetime
from typing import Any

# ── Constants ────────────────────────────────────────────────────────

BUFFER_LIMIT = 256 * 1024  # 256 KB
COMMAND_OUTPUT_LIMIT = 1024 * 1024  # 1 MB
MAX_SESSIONS = 50

# ── Danger patterns ─────────────────────────────────────────────────

DANGEROUS_PATTERNS = [
    "rm -rf /", "rm -rf ~", ":(){ :|:& };:", "dd if=",
    "> /dev/sda", "mkfs.", "fdisk", "format ",
    "sudo", "su ", "chown", "chmod 777",
    "kill -9", "pkill", "shutdown", "reboot",
]


def _dangerous_reason(command: str) -> str | None:
    for pattern in DANGEROUS_PATTERNS:
        if pattern in command.lower():
            return f"Command contains dangerous pattern: {pattern}"
    return None


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _get_shell() -> str:
    if platform.system() == "Windows":
        return os.environ.get("COMSPEC", "cmd.exe")
    return os.environ.get("SHELL", "/bin/bash")


# ── Session data ─────────────────────────────────────────────────────

_sessions: dict[str, dict[str, Any]] = {}
_pending_approvals: dict[str, dict[str, Any]] = {}
_ws_sockets: dict[str, set[Any]] = {}  # session_id → set of WS connections


def _summarize(session: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": session["id"],
        "title": session.get("title", "Terminal"),
        "cwd": session.get("cwd", ""),
        "command": session.get("command", ""),
        "status": session.get("status", "created"),
        "createdAt": session.get("createdAt", ""),
        "updatedAt": session.get("updatedAt", ""),
        "bufferLength": len(session.get("buffer", "")),
        "approvedInteractive": session.get("approvedInteractive", False),
        "cols": session.get("cols", 80),
        "rows": session.get("rows", 24),
        "pty": session.get("pty", False),
    }


# ── Session CRUD ─────────────────────────────────────────────────────


def list_terminal_sessions() -> list[dict[str, Any]]:
    return [_summarize(s) for s in _sessions.values()][:MAX_SESSIONS]


def list_terminal_approvals() -> list[dict[str, Any]]:
    return list(_pending_approvals.values())


async def create_terminal_session(params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Create a terminal session with a running shell process."""
    params = params or {}
    session_id = f"term_{uuid.uuid4().hex[:8]}"
    shell = _get_shell()

    session = {
        "id": session_id,
        "title": params.get("title", "Terminal"),
        "cwd": params.get("cwd") or os.getcwd(),
        "command": params.get("command", shell),
        "status": "starting",
        "createdAt": _now(),
        "updatedAt": _now(),
        "buffer": "",
        "approvedInteractive": params.get("approvedInteractive", False),
        "cols": params.get("cols", 80),
        "rows": params.get("rows", 24),
        "pty": False,
        "process": None,
        "stdin": None,
        "stdout": None,
    }

    # Spawn the shell process
    try:
        args = params.get("args") or (["-i"] if platform.system() != "Windows" else [])
        proc = await asyncio.create_subprocess_exec(
            shell, *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            cwd=session["cwd"],
            env={**os.environ, "TERM": "xterm-256color"},
        )
        session["process"] = proc
        session["stdin"] = proc.stdin
        session["stdout"] = proc.stdout
        session["status"] = "running"
        _sessions[session_id] = session
        _ws_sockets[session_id] = set()

        # Background stdout reader
        asyncio.create_task(_pipe_stdout(session_id))

    except (FileNotFoundError, PermissionError) as exc:
        session["status"] = "error"
        session["error"] = str(exc)
        _sessions[session_id] = session

    return _summarize(session)


async def _pipe_stdout(session_id: str) -> None:
    """Read process stdout into the session buffer and broadcast to WS."""
    session = _sessions.get(session_id)
    if not session or not session.get("stdout"):
        return
    try:
        while True:
            chunk = await session["stdout"].read(4096)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            # Append to buffer (capped)
            session["buffer"] = (session.get("buffer", "") + text)[-BUFFER_LIMIT:]
            session["updatedAt"] = _now()
            # Broadcast to all WebSocket connections
            for ws in list(_ws_sockets.get(session_id, set())):
                try:
                    ws(text)
                except Exception:
                    _ws_sockets.get(session_id, set()).discard(ws)
    except (OSError, ValueError):
        pass
    finally:
        if session_id in _sessions:
            s = _sessions[session_id]
            if s.get("status") == "running":
                s["status"] = "exited"


def read_terminal_buffer(session_id: str) -> dict[str, Any]:
    """Get the terminal buffer for a session."""
    session = _sessions.get(session_id)
    if not session:
        raise KeyError(f"Terminal session not found: {session_id}")
    return {**_summarize(session), "buffer": session.get("buffer", "")}


async def write_terminal_input(session_id: str, input_text: str, approved: bool = False) -> dict[str, Any]:
    """Write input to a terminal session."""
    session = _sessions.get(session_id)
    if not session:
        return {"error": "Session not found"}

    # Check approval for interactive mode
    if not session.get("approvedInteractive") and not approved:
        req_id = f"apr_{uuid.uuid4().hex[:8]}"
        _pending_approvals[req_id] = {
            "requestId": req_id,
            "type": "terminal_interactive_input",
            "terminalId": session_id,
            "createdAt": _now(),
        }
        return {"status": "approval_required", "requestId": req_id}

    stdin = session.get("stdin")
    if not stdin:
        return {"error": "Process stdin not available"}

    try:
        stdin.write(input_text.encode())
        await stdin.drain()
        return {"status": "written"}
    except (BrokenPipeError, OSError) as exc:
        return {"error": str(exc)}


async def resize_terminal_session(session_id: str, cols: int = 80, rows: int = 24) -> dict[str, Any]:
    """Resize a terminal session."""
    cols = max(20, min(cols, 240))
    rows = max(5, min(rows, 120))
    session = _sessions.get(session_id)
    if session:
        session["cols"] = cols
        session["rows"] = rows
    return _summarize(session) if session else {"error": "Session not found"}


async def submit_terminal_command(params: dict[str, Any]) -> dict[str, Any]:
    """Run a one-shot command and return output."""
    command = params.get("command", "")
    cwd = params.get("cwd") or os.getcwd()
    approved = params.get("approved", False)
    reason = params.get("reason", "")
    timeout_ms = params.get("timeoutMs", 30000)

    # Check for dangerous commands
    if not approved:
        danger = _dangerous_reason(command)
        if danger:
            req_id = f"apr_{uuid.uuid4().hex[:8]}"
            _pending_approvals[req_id] = {
                "requestId": req_id,
                "type": "terminal_command",
                "command": command,
                "cwd": cwd,
                "reason": danger,
                "createdAt": _now(),
            }
            return {"status": "approval_required", "requestId": req_id, "reason": danger}

    # Execute
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_ms / 1000)
        output = stdout.decode("utf-8", errors="replace")[-COMMAND_OUTPUT_LIMIT:]
        if stderr:
            error = stderr.decode("utf-8", errors="replace")[-COMMAND_OUTPUT_LIMIT:]
            if error:
                output += f"\nSTDERR:\n{error}"
        return {
            "status": "completed",
            "command": command,
            "cwd": cwd,
            "exitCode": proc.returncode,
            "output": output,
            "timedOut": False,
        }
    except asyncio.TimeoutError:
        return {"status": "error", "command": command, "error": "Timed out", "timedOut": True}
    except Exception as exc:
        return {"status": "error", "command": command, "error": str(exc)}


async def approve_terminal_request(request_id: str, approve: bool = True) -> dict[str, Any]:
    """Approve or reject a pending terminal request."""
    request = _pending_approvals.pop(request_id, None)
    if not request:
        return {"error": "Request not found"}

    if not approve:
        return {"status": "rejected", "requestId": request_id}

    if request.get("type") == "terminal_command":
        return await submit_terminal_command({
            "command": request.get("command", ""),
            "cwd": request.get("cwd", ""),
            "approved": True,
        })

    if request.get("type") == "terminal_interactive_input":
        session_id = request.get("terminalId", "")
        session = _sessions.get(session_id)
        if session:
            session["approvedInteractive"] = True
        return {"status": "approved_interactive", "terminalId": session_id}

    return {"status": "approved", "requestId": request_id}


def close_terminal_session(session_id: str) -> bool:
    """Close and remove a terminal session."""
    session = _sessions.pop(session_id, None)
    if not session:
        return False
    # Close WebSocket connections
    sockets = _ws_sockets.pop(session_id, set())
    for ws in sockets:
        try:
            ws(None)  # Signal close
        except Exception:
            pass
    # Kill process
    proc = session.get("process")
    if proc:
        try:
            proc.kill()
        except Exception:
            pass
    return True


# ── WebSocket handler ────────────────────────────────────────────────


async def handle_terminal_connection(websocket: Any, terminal_id: str) -> None:
    """Handle a WebSocket connection for live terminal I/O.

    ``websocket`` must have ``send_text``, ``receive_text``, ``close`` methods
    (compatible with Starlette / FastAPI WebSocket).
    """
    session = _sessions.get(terminal_id)
    if not session:
        await websocket.close(code=4004)
        return

    # Register socket
    if terminal_id not in _ws_sockets:
        _ws_sockets[terminal_id] = set()
    _ws_sockets[terminal_id].add(websocket)

    try:
        # Send existing buffer
        buffer = session.get("buffer", "")
        if buffer:
            await websocket.send_text(buffer)

        # Handle incoming messages
        while True:
            data = await websocket.receive_text()
            result = await write_terminal_input(terminal_id, data, approved=session.get("approvedInteractive", False))
            if result.get("status") == "approval_required":
                await websocket.send_text(f"\r\n[Approval required for interactive input]\r\n")
    except Exception:
        pass
    finally:
        _ws_sockets.get(terminal_id, set()).discard(websocket)
        try:
            await websocket.close()
        except Exception:
            pass
