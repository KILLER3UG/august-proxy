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
from typing import Protocol, cast
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


def _defaultShellArgs(shell: str) -> list[str]:
    """Shell-appropriate interactive flags (``-i`` breaks PowerShell)."""
    base = os.path.basename(shell).lower()
    if base in ('pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'):
        # Interactive login shell; do not pass -i (bash-only).
        return ['-NoLogo']
    if base in ('cmd.exe', 'cmd'):
        return []
    # bash, zsh, fish, etc.
    return ['-i']


def openExternalTerminal(cwd: str = '', shell: str = '') -> dict[str, object]:
    """Launch a real OS terminal window (Windows Terminal / PowerShell / Terminal.app)."""
    import shutil
    import subprocess

    workdir = cwd.strip() if cwd else os.getcwd()
    if not os.path.isdir(workdir):
        workdir = os.getcwd()
    shell_cmd = shell.strip() or _getShell()
    system = platform.system()
    try:
        if system == 'Windows':
            wt = shutil.which('wt.exe') or shutil.which('wt')
            if wt:
                # Windows Terminal — real tab/window
                subprocess.Popen(
                    [wt, '-d', workdir],
                    cwd=workdir,
                    creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
                )
                return {'ok': True, 'via': 'windows-terminal', 'cwd': workdir}
            # Fallback: new console PowerShell / cmd
            base = os.path.basename(shell_cmd).lower()
            creation = getattr(subprocess, 'CREATE_NEW_CONSOLE', 0x00000010)
            if base in ('pwsh.exe', 'pwsh', 'powershell.exe', 'powershell'):
                subprocess.Popen(
                    [shell_cmd, '-NoLogo', '-NoExit', '-Command', f"Set-Location -LiteralPath '{workdir}'"],
                    cwd=workdir,
                    creationflags=creation,
                )
            else:
                subprocess.Popen(
                    [shell_cmd],
                    cwd=workdir,
                    creationflags=creation,
                )
            return {'ok': True, 'via': 'console', 'cwd': workdir, 'shell': shell_cmd}
        if system == 'Darwin':
            # Open Terminal.app in the workspace folder
            script = f'tell application "Terminal" to do script "cd {workdir.replace(chr(34), chr(92)+chr(34))}"'
            subprocess.Popen(['osascript', '-e', script])
            return {'ok': True, 'via': 'terminal-app', 'cwd': workdir}
        # Linux: try common terminal emulators
        for term in (
            'gnome-terminal',
            'konsole',
            'xfce4-terminal',
            'x-terminal-emulator',
            'xterm',
        ):
            path = shutil.which(term)
            if not path:
                continue
            if 'gnome' in term or term == 'x-terminal-emulator':
                subprocess.Popen([path, '--working-directory', workdir])
            elif term == 'konsole':
                subprocess.Popen([path, '--workdir', workdir])
            elif 'xfce' in term:
                subprocess.Popen([path, f'--working-directory={workdir}'])
            else:
                subprocess.Popen([path], cwd=workdir)
            return {'ok': True, 'via': term, 'cwd': workdir}
        return {'ok': False, 'error': 'No terminal emulator found on PATH'}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}


_sessions: dict[str, dict[str, object]] = {}
_pendingApprovals: dict[str, dict[str, object]] = {}
# Per-session set of asyncio.Queue subscribers for live PTY/pipe output.
# Each WebSocket owns one queue; readers push chunks, handleTerminalConnection
# drains into websocket.send_text. (Never store raw WebSocket objects here —
# calling them as callables silently drops output.)
_wsQueues: dict[str, set[asyncio.Queue[str | None]]] = {}


def _broadcastTerminal(sessionId: str, text: str) -> None:
    """Fan-out a chunk to all live WebSocket subscriber queues."""
    for queue in list(_wsQueues.get(sessionId, set())):
        try:
            queue.put_nowait(text)
        except Exception:
            _wsQueues.get(sessionId, set()).discard(queue)


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
        'error': as_str(session.get('error'), '') or None,
        'shell': as_str(session.get('command'), ''),
    }


def listTerminalSessions() -> list[dict[str, object]]:
    return [_summarize(s) for s in _sessions.values()][:MAX_SESSIONS]


def listTerminalApprovals() -> list[dict[str, object]]:
    return list(_pendingApprovals.values())


async def createTerminalSession(params: dict[str, object] | None = None) -> dict[str, object]:
    """Create a terminal session with a running shell process (PTY).

    Interactive drawer terminals default to ``approvedInteractive=True`` so
    keystrokes go straight to a real shell (PowerShell/bash) without a
    permission gate on every character.
    """
    params = params or {}
    sessionId = f'term_{uuid.uuid4().hex[:8]}'
    shell = as_str(params.get('command')) or _getShell()
    cwd = as_str(params.get('cwd')) or os.getcwd()
    if not os.path.isdir(cwd):
        cwd = os.getcwd()
    # Drawer / interactive sessions: real shell without per-keystroke approval
    if 'approvedInteractive' in params or 'approved_interactive' in params:
        approved = as_bool(
            params.get('approvedInteractive', params.get('approved_interactive', True))
        )
    else:
        approved = True
    pty = PtyIO()
    session = {
        'id': sessionId,
        'title': as_str(params.get('title'), 'Terminal'),
        'cwd': cwd,
        'command': shell,
        'status': 'starting',
        'createdAt': _now(),
        'updatedAt': _now(),
        'buffer': '',
        'approvedInteractive': approved,
        'cols': as_int(params.get('cols'), 80),
        'rows': as_int(params.get('rows'), 24),
        'pty': True,
        'pty_io': pty,
        'process': None,
        'stdin': None,
        'stdout': None,
        'error': None,
    }
    explicit_args = [as_str(a) for a in as_list(params.get('args'))]
    args = explicit_args if explicit_args else _defaultShellArgs(shell)
    env = {**os.environ, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'}
    try:
        await pty.spawn(
            shell=shell,
            args=args,
            cwd=str(session['cwd']),
            env=env,
            cols=as_int(session.get('cols'), 80),
            rows=as_int(session.get('rows'), 24),
        )
        session['status'] = 'running'
        session['pty'] = True
        _sessions[sessionId] = session
        _wsQueues[sessionId] = set()
        task = asyncio.create_task(_pipePtyStdout(sessionId))
        session['reader_task'] = task
    except (FileNotFoundError, PermissionError, ImportError, OSError) as exc:
        # Fall back to a real subprocess shell (no full PTY) so the drawer still works
        # when pywinpty is missing on Windows.
        try:
            proc = await asyncio.create_subprocess_exec(
                shell,
                *args,
                cwd=str(session['cwd']),
                env=env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            session['process'] = proc
            session['stdin'] = proc.stdin
            session['stdout'] = proc.stdout
            session['pty'] = False
            session['pty_io'] = None
            session['status'] = 'running'
            session['error'] = None
            # Soft notice in buffer so user knows this is a real shell without TTY features
            notice = (
                f'[August] Real shell: {shell} (cwd={session["cwd"]})\r\n'
                f'[August] PTY unavailable ({exc}); using pipe mode. '
                f'For full TTY: pip install pywinpty — or click Open external terminal.\r\n\r\n'
            )
            session['buffer'] = notice
            _sessions[sessionId] = session
            _wsQueues[sessionId] = set()
            task = asyncio.create_task(_pipeStdout(sessionId))
            session['reader_task'] = task
            # Broadcast notice to any early subscribers
            _broadcastTerminal(sessionId, notice)
        except Exception as exc2:
            session['status'] = 'error'
            session['error'] = (
                f'Could not start shell: {exc2}. '
                'Use “Open external terminal” for a full OS window, '
                'or install pywinpty: pip install pywinpty'
            )
            session['pty'] = False
            _sessions[sessionId] = session
    return {**_summarize(session), 'error': session.get('error')}


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
            _broadcastTerminal(sessionId, text)
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
            try:
                chunk = await asyncio.wait_for(pty.read(4096), timeout=5.0)
            except asyncio.TimeoutError:
                continue
            if not chunk:
                # Soft EOF from PtyIO — confirm process still open before exit
                if not pty.isOpen:
                    break
                await asyncio.sleep(0.05)
                continue
            text = chunk.decode('utf-8', errors='replace')
            session['buffer'] = (as_str(session.get('buffer'), '') + text)[-BUFFER_LIMIT:]
            session['updatedAt'] = _now()
            _broadcastTerminal(sessionId, text)
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
        from app.lib.async_subprocess import (
            SubprocessAborted,
            agent_subprocess_kwargs,
            communicate_or_kill,
        )

        proc = await asyncio.create_subprocess_shell(
            command,
            **agent_subprocess_kwargs(cwd=cwd),
        )
        stdout, stderr = await communicate_or_kill(proc, timeout=timeoutMs / 1000)
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
    except SubprocessAborted as abort:
        return {
            'status': 'error',
            'command': command,
            'error': 'Cancelled' if abort.reason == 'cancelled' else 'Timed out',
            'timedOut': abort.reason == 'timeout',
        }
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


async def closeTerminalSession(sessionId: str) -> bool:
    """Close and remove a terminal session."""
    from app.lib.async_subprocess import close_process

    session = _sessions.pop(sessionId, None)
    if not session:
        return False
    queues = _wsQueues.pop(sessionId, set())
    for queue in queues:
        try:
            queue.put_nowait(None)
        except Exception:
            pass
    readerTask = cast(asyncio.Task[None] | None, session.get('reader_task'))
    if readerTask:
        readerTask.cancel()
        try:
            await readerTask
        except (asyncio.CancelledError, Exception):
            pass
    pty = cast(PtyIO | None, session.get('pty_io'))
    if pty:
        try:
            await pty.close()
        except Exception:
            pass
    proc = cast(asyncio.subprocess.Process | None, session.get('process'))
    if proc:
        await close_process(proc)
    return True


async def closeAllTerminalSessions() -> None:
    """Close every terminal session (app shutdown)."""
    for sid in list(_sessions.keys()):
        try:
            await closeTerminalSession(sid)
        except Exception:
            pass


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
    if terminalId not in _wsQueues:
        _wsQueues[terminalId] = set()
    out_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=256)
    _wsQueues[terminalId].add(out_queue)

    async def _pump_output() -> None:
        while True:
            chunk = await out_queue.get()
            if chunk is None:
                break
            await ws.send_text(chunk)

    pump = asyncio.create_task(_pump_output())
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
        _wsQueues.get(terminalId, set()).discard(out_queue)
        try:
            out_queue.put_nowait(None)
        except Exception:
            pass
        pump.cancel()
        try:
            await pump
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await ws.close()
        except Exception:
            pass
