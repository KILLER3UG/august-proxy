"""
Terminal service — interactive terminal sessions with PTY/stdin support.

Supports the /api/terminal/* REST API + WebSocket live I/O.
"""

from __future__ import annotations
import asyncio
import os
import platform
import uuid
from datetime import datetime, timezone
from typing import Callable, Protocol, cast
from app.json_narrowing import as_bool, as_int, as_list, as_str
from app.services.workbench.pty_io import PtyIO

BUFFER_LIMIT = 256 * 1024
COMMAND_OUTPUT_LIMIT = 1024 * 1024
MAX_SESSIONS = 50
DANGEROUS_PATTERNS = [
    'rm -rf /',
    'rm -rf ~',
    ':(){ :|:& };:',
    'dd if=',
    '> /dev/sda',
    'mkfs.',
    'fdisk',
    'format ',
    'sudo',
    'su ',
    'chown',
    'chmod 777',
    'kill -9',
    'pkill',
    'shutdown',
    'reboot',
]


def _dangerousReason(command: str) -> str | None:
    for pattern in DANGEROUS_PATTERNS:
        if pattern in command.lower():
            return f'Command contains dangerous pattern: {pattern}'
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _getShell() -> str:
    if platform.system() == 'Windows':
        import shutil

        for candidate in ['pwsh.exe', 'powershell.exe', 'bash.exe', 'cmd.exe']:
            if shutil.which(candidate):
                return candidate
        return os.environ.get('COMSPEC', 'cmd.exe')
    return os.environ.get('SHELL', '/bin/bash')


_sessions: dict[str, dict[str, object]] = {}
_pendingApprovals: dict[str, dict[str, object]] = {}
_wsSockets: dict[str, set[object]] = {}


class _WebSocketLike(Protocol):
    """Minimal structural shape for a Starlette/FastAPI-style WebSocket."""

    async def close(self, code: int = 1000) -> None: ...
    async def send_text(self, data: str) -> None: ...
    async def receive_text(self) -> str: ...


def _summarize(session: dict[str, object]) -> dict[str, object]:
    return {
        'id': session['id'],
        'title': as_str(session.get('title'), 'Terminal'),
        'cwd': as_str(session.get('cwd'), ''),
        'command': as_str(session.get('command'), ''),
        'status': as_str(session.get('status'), 'created'),
        'createdAt': as_str(session.get('createdAt'), ''),
        'updatedAt': as_str(session.get('updatedAt'), ''),
        'bufferLength': len(as_str(session.get('buffer'), '')),
        'approvedInteractive': as_bool(session.get('approvedInteractive', False)),
        'cols': as_int(session.get('cols'), 80),
        'rows': as_int(session.get('rows'), 24),
        'pty': as_bool(session.get('pty', False)),
    }


def listTerminalSessions() -> list[dict[str, object]]:
    return [_summarize(s) for s in _sessions.values()][:MAX_SESSIONS]


def listTerminalApprovals() -> list[dict[str, object]]:
    return list(_pendingApprovals.values())


async def createTerminalSession(params: dict[str, object] | None = None) -> dict[str, object]:
    """Create a terminal session with a running shell process (PTY)."""
    params = params or {}
    sessionId = f'term_{uuid.uuid4().hex[:8]}'
    shell = _getShell()
    pty = PtyIO()
    session = {
        'id': sessionId,
        'title': as_str(params.get('title'), 'Terminal'),
        'cwd': as_str(params.get('cwd')) or os.getcwd(),
        'command': as_str(params.get('command'), shell),
        'status': 'starting',
        'createdAt': _now(),
        'updatedAt': _now(),
        'buffer': '',
        'approvedInteractive': as_bool(params.get('approvedInteractive', False)),
        'cols': as_int(params.get('cols'), 80),
        'rows': as_int(params.get('rows'), 24),
        'pty': True,
        'pty_io': pty,
        'process': None,
        'stdin': None,
        'stdout': None,
    }
    try:
        args = [as_str(a) for a in as_list(params.get('args'))] or ['-i']
        await pty.spawn(
            shell=shell,
            args=args,
            cwd=str(session['cwd']),
            env={**os.environ, 'TERM': 'xterm-256color'},
            cols=as_int(session.get('cols'), 80),
            rows=as_int(session.get('rows'), 24),
        )
        session['status'] = 'running'
        _sessions[sessionId] = session
        _wsSockets[sessionId] = set()
        task = asyncio.create_task(_pipePtyStdout(sessionId))
        session['reader_task'] = task
    except (FileNotFoundError, PermissionError, ImportError) as exc:
        session['status'] = 'error'
        session['error'] = str(exc)
        session['pty'] = False
        _sessions[sessionId] = session
    return _summarize(session)


async def _pipeStdout(sessionId: str) -> None:
    """Read process stdout into the session buffer and broadcast to WS."""
    session = _sessions.get(sessionId)
    if not session:
        return
    stdout = session.get('stdout')
    if not stdout:
        return
    reader = cast(asyncio.StreamReader, stdout)
    try:
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                break
            text = chunk.decode('utf-8', errors='replace')
            session['buffer'] = (as_str(session.get('buffer'), '') + text)[-BUFFER_LIMIT:]
            session['updatedAt'] = _now()
            for ws in list(_wsSockets.get(sessionId, set())):
                try:
                    cast(Callable[[object], None], ws)(text)
                except Exception:
                    _wsSockets.get(sessionId, set()).discard(ws)
    except (OSError, ValueError):
        pass
    finally:
        if sessionId in _sessions:
            s = _sessions[sessionId]
            if as_str(s.get('status')) == 'running':
                s['status'] = 'exited'


async def _pipePtyStdout(sessionId: str) -> None:
    """Read PTY output into the session buffer and broadcast to WS."""
    session = _sessions.get(sessionId)
    if not session:
        return
    pty = cast(PtyIO | None, session.get('pty_io'))
    if not pty:
        return
    try:
        while pty.isOpen:
            chunk = await pty.read(4096)
            if not chunk:
                break
            text = chunk.decode('utf-8', errors='replace')
            session['buffer'] = (as_str(session.get('buffer'), '') + text)[-BUFFER_LIMIT:]
            session['updatedAt'] = _now()
            for ws in list(_wsSockets.get(sessionId, set())):
                try:
                    cast(Callable[[object], None], ws)(text)
                except Exception:
                    _wsSockets.get(sessionId, set()).discard(ws)
    except Exception:
        pass
    finally:
        if sessionId in _sessions:
            s = _sessions[sessionId]
            if as_str(s.get('status')) == 'running':
                s['status'] = 'exited'


def readTerminalBuffer(sessionId: str) -> dict[str, object]:
    """Get the terminal buffer for a session."""
    session = _sessions.get(sessionId)
    if not session:
        raise KeyError(f'Terminal session not found: {sessionId}')
    return {**_summarize(session), 'buffer': as_str(session.get('buffer'), '')}


async def writeTerminalInput(sessionId: str, inputText: str, approved: bool = False) -> dict[str, object]:
    """Write input to a terminal session."""
    session = _sessions.get(sessionId)
    if not session:
        return {'error': 'Session not found'}
    if not as_bool(session.get('approvedInteractive', False)) and (not approved):
        reqId = f'apr_{uuid.uuid4().hex[:8]}'
        _pendingApprovals[reqId] = {
            'requestId': reqId,
            'type': 'terminal_interactive_input',
            'terminalId': sessionId,
            'createdAt': _now(),
        }
        return {'status': 'approval_required', 'requestId': reqId}
    pty = cast(PtyIO | None, session.get('pty_io'))
    if pty and as_bool(session.get('pty', False)):
        try:
            await pty.write(inputText)
            return {'status': 'written'}
        except Exception as exc:
            return {'error': str(exc)}
    stdin = cast(asyncio.StreamWriter | None, session.get('stdin'))
    if not stdin:
        return {'error': 'Process stdin not available'}
    try:
        stdin.write(inputText.encode())
        await stdin.drain()
        return {'status': 'written'}
    except (BrokenPipeError, OSError) as exc:
        return {'error': str(exc)}


async def resizeTerminalSession(sessionId: str, cols: int = 80, rows: int = 24) -> dict[str, object]:
    """Resize a terminal session."""
    cols = max(20, min(cols, 240))
    rows = max(5, min(rows, 120))
    session = _sessions.get(sessionId)
    if session:
        session['cols'] = cols
        session['rows'] = rows
        pty = cast(PtyIO | None, session.get('pty_io'))
        if pty:
            try:
                pty.resize(cols, rows)
            except Exception:
                pass
    return _summarize(session) if session else {'error': 'Session not found'}


async def submitTerminalCommand(params: dict[str, object]) -> dict[str, object]:
    """Run a one-shot command and return output."""
    command = as_str(params.get('command'), '')
    cwd = as_str(params.get('cwd')) or os.getcwd()
    approved = as_bool(params.get('approved', False))
    timeoutMs = as_int(params.get('timeoutMs'), 30000)
    if not approved:
        danger = _dangerousReason(command)
        if danger:
            reqId = f'apr_{uuid.uuid4().hex[:8]}'
            _pendingApprovals[reqId] = {
                'requestId': reqId,
                'type': 'terminal_command',
                'command': command,
                'cwd': cwd,
                'reason': danger,
                'createdAt': _now(),
            }
            return {'status': 'approval_required', 'requestId': reqId, 'reason': danger}
    try:
        proc = await asyncio.create_subprocess_shell(
            command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=cwd
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeoutMs / 1000)
        output = stdout.decode('utf-8', errors='replace')[-COMMAND_OUTPUT_LIMIT:]
        if stderr:
            error = stderr.decode('utf-8', errors='replace')[-COMMAND_OUTPUT_LIMIT:]
            if error:
                output += f'\nSTDERR:\n{error}'
        return {
            'status': 'completed',
            'command': command,
            'cwd': cwd,
            'exitCode': proc.returncode,
            'output': output,
            'timedOut': False,
        }
    except asyncio.TimeoutError:
        return {'status': 'error', 'command': command, 'error': 'Timed out', 'timedOut': True}
    except Exception as exc:
        return {'status': 'error', 'command': command, 'error': str(exc)}


async def approveTerminalRequest(requestId: str, approve: bool = True) -> dict[str, object]:
    """Approve or reject a pending terminal request."""
    request = _pendingApprovals.pop(requestId, None)
    if not request:
        return {'error': 'Request not found'}
    if not approve:
        return {'status': 'rejected', 'requestId': requestId}
    if as_str(request.get('type')) == 'terminal_command':
        return await submitTerminalCommand(
            {'command': as_str(request.get('command'), ''), 'cwd': as_str(request.get('cwd'), ''), 'approved': True}
        )
    if as_str(request.get('type')) == 'terminal_interactive_input':
        sessionId = as_str(request.get('terminalId'), '')
        session = _sessions.get(sessionId)
        if session:
            session['approvedInteractive'] = True
        return {'status': 'approved_interactive', 'terminalId': sessionId}
    return {'status': 'approved', 'requestId': requestId}


def closeTerminalSession(sessionId: str) -> bool:
    """Close and remove a terminal session."""
    session = _sessions.pop(sessionId, None)
    if not session:
        return False
    sockets = _wsSockets.pop(sessionId, set())
    for ws in sockets:
        try:
            cast(Callable[[object], None], ws)(None)
        except Exception:
            pass
    readerTask = cast(asyncio.Task[None] | None, session.get('reader_task'))
    if readerTask:
        readerTask.cancel()
    pty = cast(PtyIO | None, session.get('pty_io'))
    if pty:
        try:
            asyncio.create_task(pty.close())
        except Exception:
            pass
    proc = cast(asyncio.subprocess.Process | None, session.get('process'))
    if proc:
        try:
            proc.kill()
        except Exception:
            pass
    return True


async def handleTerminalConnection(websocket: object, terminalId: str) -> None:
    """Handle a WebSocket connection for live terminal I/O.

    ``websocket`` must have ``send_text``, ``receive_text``, ``close`` methods
    (compatible with Starlette / FastAPI WebSocket).
    """
    session = _sessions.get(terminalId)
    ws = cast(_WebSocketLike, websocket)
    if not session:
        await ws.close(code=4004)
        return
    if terminalId not in _wsSockets:
        _wsSockets[terminalId] = set()
    _wsSockets[terminalId].add(websocket)
    try:
        buffer = as_str(session.get('buffer'), '')
        if buffer:
            await ws.send_text(buffer)
        while True:
            data = await ws.receive_text()
            result = await writeTerminalInput(
                terminalId, data, approved=as_bool(session.get('approvedInteractive', False))
            )
            if as_str(result.get('status')) == 'approval_required':
                await ws.send_text('\r\n[Approval required for interactive input]\r\n')
    except Exception:
        pass
    finally:
        _wsSockets.get(terminalId, set()).discard(websocket)
        try:
            await ws.close()
        except Exception:
            pass
