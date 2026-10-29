"""Background commands: one process, a foreground wait, then a tracked task.

The old `run_command` blocked for the whole command. That wastes the user's
time and can outlive the provider's prompt cache. This manager keeps the SAME
process running when the turn stops waiting: it starts `run_sandboxed`, waits
a bounded foreground interval, and if the command is still running it returns a
task id while the process continues. Nothing is killed and nothing is re-run.

The task table lives outside the transcript (metadata + log under the data
dir), so a compaction cannot lose a result nobody has read. Completion is
delivered as a queued machine message, not by polling. A restart cannot
reattach to a child process, so a task still marked `running` on disk is
reported `orphaned` instead of pretending to be alive.

The sandbox policy and approvals are resolved by `run_command` before this
module is called; this manager only owns execution and accounting.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from app.lib.async_subprocess import current_command_output
from app.services.execution_world import run_sandboxed
from app.services.sandbox.policy import SandboxPolicy, SandboxResult

logger = logging.getLogger('august.background')

#: How long `run_command` waits before handing the task back to the turn.
#: Kept below a typical provider prompt-cache lifetime so a long build does not
#: both block the user and guarantee a cold next request.
DEFAULT_FOREGROUND_WAIT_S = 60.0
#: A session with more than this many live background commands is refused;
#: the cap is about runaway processes, not context.
MAX_TASKS_PER_SESSION = 8
#: On-disk output ceiling. The final SandboxResult still carries the full text
#: in memory for the immediate foreground path, but a background log is a
#: durable file and must not be allowed to fill the disk.
MAX_LOG_BYTES = 8 * 1024 * 1024
PREVIEW_CHARS = 3000
RETENTION_DAYS = 7
_TAIL_DEFAULT = 8000
_SESSION_KEY_RE = re.compile(r'[^A-Za-z0-9._-]+')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _data_root() -> Path:
    from app.config import settings

    return Path(settings.dataDir) / 'background'


def _session_dir(session_id: str) -> Path:
    raw = (session_id or 'default').strip() or 'default'
    safe = _SESSION_KEY_RE.sub('_', raw)[:80]
    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:12]
    return _data_root() / f'{safe}-{digest}'


def _short_command(command: str, limit: int = 200) -> str:
    cleaned = ' '.join(str(command or '').split())
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1] + '…'


def _valid_task_id(task_id: str) -> bool:
    return bool(re.fullmatch(r'bg_[A-Za-z0-9]{6,32}', str(task_id or '')))


def _display_elapsed(bg: 'BackgroundCommand') -> str:
    if bg.status == 'running' and bg.startedMono > 0:
        seconds = max(0, int(time.monotonic() - bg.startedMono))
    elif bg.elapsedMs:
        seconds = max(0, int(bg.elapsedMs / 1000))
    else:
        return '?'
    return f'{seconds}s'


def _classify(result: SandboxResult) -> str:
    if result.denial_reason:
        return 'blocked'
    if result.ok:
        return 'completed'
    message = f'{result.stderr}\n{result.stdout}'.lower()
    if 'cancelled by user' in message:
        return 'killed'
    if 'timed out' in message:
        return 'timed_out'
    return 'failed'


@dataclass
class BackgroundCommand:
    id: str
    sessionId: str
    command: str
    workspace: str
    logPath: Path
    metaPath: Path
    startedAt: str
    status: str = 'running'
    exitCode: int | None = None
    endedAt: str = ''
    elapsedMs: int = 0
    resultText: str = ''
    sandboxResult: SandboxResult | None = None
    detached: bool = False
    notified: bool = False
    silent: bool = False
    forwardUntil: float = 0.0
    startedMono: float = 0.0
    logBytes: int = 0
    logCapped: bool = False
    task: asyncio.Task[None] | None = field(default=None, repr=False)


@dataclass
class RunOutcome:
    """What `run` hands back to `run_command`.

    ``detached`` means the turn must return the text immediately; the process
    is still alive. Otherwise ``result`` is the completed SandboxResult and the
    caller keeps its existing denial/approval formatting.
    """

    detached: bool
    text: str
    result: SandboxResult | None = None
    taskId: str = ''
    logPath: str = ''


class BackgroundCommandManager:
    def __init__(self) -> None:
        self._tasks: dict[str, BackgroundCommand] = {}
        self._notifier: Callable[[str, str], None] | None = None
        self._lastPrune = 0.0

    # ── notification door (overridable in a probe) ──────────────────────
    def setNotifier(self, notifier: Callable[[str, str], None] | None) -> None:
        self._notifier = notifier

    def _notify(self, bg: BackgroundCommand) -> None:
        if bg.silent or bg.notified:
            return
        bg.notified = True
        text = self._notification_text(bg)
        if self._notifier is not None:
            try:
                self._notifier(bg.sessionId, text)
            except Exception:  # noqa: BLE001 -- a failure to notify must not kill the task
                logger.debug('background notifier failed', exc_info=True)
            return
        try:
            from app.services.workbench.workbench import enqueueUserMessage

            enqueueUserMessage(bg.sessionId, text, kind='shell')
        except Exception:  # noqa: BLE001 -- a failed notification must not kill the task
            logger.debug('background notify enqueue failed', exc_info=True)
            return
        try:
            from app.routers.workbench import scheduleSubagentAutoTurn

            scheduleSubagentAutoTurn(bg.sessionId)
        except Exception:  # noqa: BLE001 -- a failed auto-turn must not kill the task
            logger.debug('background notify auto-turn failed', exc_info=True)

    def _notification_text(self, bg: BackgroundCommand) -> str:
        status = bg.status.upper()
        exitPart = f' exit="{bg.exitCode}"' if bg.exitCode is not None else ''
        body = bg.resultText or self._tail(bg.logPath, PREVIEW_CHARS) or '(no output)'
        if len(body) > PREVIEW_CHARS:
            body = '…' + body[-PREVIEW_CHARS:]
        return (
            f'[BACKGROUND_COMMAND_{status} id="{bg.id}" status="{bg.status}"{exitPart}]\n'
            f'Command: {_short_command(bg.command, 500)}\n'
            f'{body}\n'
            f'Full log: {bg.logPath}\n'
            f'Use read_background_task("{bg.id}") to read more; do not re-run the command.\n'
            f'[/BACKGROUND_COMMAND_{status}]'
        )

    # ── lifecycle ───────────────────────────────────────────────────────
    async def run(
        self,
        *,
        command: str,
        policy: SandboxPolicy,
        timeout: float,
        session_id: str,
        workspace: str,
        format_result: Callable[[SandboxResult], str],
        on_output: Callable[[str], Any] | None = None,
        background: bool = False,
        foreground_wait: float = DEFAULT_FOREGROUND_WAIT_S,
    ) -> RunOutcome:
        self._prune_once()
        if len(self._tasks) > 256:
            finished = [
                item for item in self._tasks.values() if item.status != 'running' and item.task is not None and item.task.done()
            ]
            for item in finished[: len(finished) - 200]:
                self._tasks.pop(item.id, None)
        sessionId = (session_id or 'default').strip() or 'default'
        active = [
            task
            for task in self._tasks.values()
            if task.sessionId == sessionId and task.status == 'running' and not task.silent
        ]
        if len(active) >= MAX_TASKS_PER_SESSION:
            return RunOutcome(
                detached=True,
                text=(
                    f'Error: this session already has {len(active)} running background '
                    f'commands (limit {MAX_TASKS_PER_SESSION}). Stop one with '
                    'kill_background_task before starting another.'
                ),
            )

        taskId = f'bg_{uuid.uuid4().hex[:12]}'
        sessionDir = _session_dir(sessionId)
        sessionDir.mkdir(parents=True, exist_ok=True)
        bg = BackgroundCommand(
            id=taskId,
            sessionId=sessionId,
            command=str(command or ''),
            workspace=str(workspace or ''),
            logPath=sessionDir / f'{taskId}.log',
            metaPath=sessionDir / f'{taskId}.json',
            startedAt=_now(),
            detached=bool(background),
            startedMono=time.monotonic(),
            forwardUntil=time.monotonic() + (0.0 if background else max(0.0, foreground_wait)),
        )
        self._tasks[taskId] = bg
        self._write_meta(bg)
        bg.task = asyncio.create_task(self._execute(bg, policy, timeout, format_result, on_output))

        def _on_task_done(_done: asyncio.Task[None]) -> None:
            self._on_done(bg)

        bg.task.add_done_callback(_on_task_done)

        if background:
            return RunOutcome(
                detached=True,
                text=self._running_text(bg, 'Started in the background.'),
                taskId=taskId,
                logPath=str(bg.logPath),
            )
        try:
            await asyncio.wait_for(asyncio.shield(bg.task), timeout=max(0.0, foreground_wait))
        except asyncio.TimeoutError:
            if bg.task.done() and not bg.task.cancelled() and bg.task.exception() is None:
                # It finished exactly at the boundary; return the result rather
                # than a "still running" message plus a duplicate notification.
                result = bg.sandboxResult
                text = bg.resultText
                self._cleanup_files(bg)
                self._tasks.pop(taskId, None)
                return RunOutcome(detached=False, text=text, result=result)
            bg.detached = True
            return RunOutcome(
                detached=True,
                text=self._running_text(bg, f'Still running after {int(foreground_wait)}s.'),
                taskId=taskId,
                logPath=str(bg.logPath),
            )
        except asyncio.CancelledError:
            bg.silent = True
            bg.task.cancel()
            self._cleanup_files(bg)
            self._tasks.pop(taskId, None)
            raise
        if bg.task.cancelled():
            self._cleanup_files(bg)
            self._tasks.pop(taskId, None)
            return RunOutcome(detached=False, text='Error: command was cancelled before it returned.')
        exc = bg.task.exception()
        if exc is not None:
            text = bg.resultText or f'Error: background command failed: {exc}'
            self._cleanup_files(bg)
            self._tasks.pop(taskId, None)
            return RunOutcome(detached=False, text=text)
        result = bg.sandboxResult
        self._cleanup_files(bg)
        self._tasks.pop(taskId, None)
        return RunOutcome(detached=False, text=bg.resultText, result=result)

    async def _execute(
        self,
        bg: BackgroundCommand,
        policy: SandboxPolicy,
        timeout: float,
        format_result: Callable[[SandboxResult], str],
        on_output: Callable[[str], Any] | None,
    ) -> None:
        async def _on_chunk(text: str) -> None:
            if not text:
                return
            self._append_log(bg, text)
            if on_output is not None and time.monotonic() < bg.forwardUntil:
                try:
                    result = on_output(text)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:  # noqa: BLE001 -- a failure to notify must not kill the task
                    pass

        token = current_command_output.set(_on_chunk)
        try:
            result = await run_sandboxed(bg.command, policy, timeout=timeout)
            bg.sandboxResult = result
            bg.exitCode = result.exit_code
            bg.status = _classify(result)
            if not bg.logBytes and (result.stdout or result.stderr):
                # A backend that did not stream still produced output; keep the
                # log complete instead of leaving a file with only our marker.
                if result.stdout:
                    self._append_log(bg, result.stdout)
                if result.stderr:
                    self._append_log(bg, result.stderr)
            try:
                text = format_result(result)
            except Exception:  # noqa: BLE001 -- a failure to notify must not kill the task
                text = result.as_tool_text()
            bg.resultText = text
        except asyncio.CancelledError:
            bg.status = 'killed'
            bg.resultText = 'Background command was stopped.'
            self._append_log(bg, '\n[stopped before completion]\n')
            raise
        except Exception as exc:  # noqa: BLE001 -- record any runner failure as the task result
            bg.status = 'failed'
            bg.resultText = f'Error: background command failed: {type(exc).__name__}: {exc}'
            self._append_log(bg, f'\n[error: {type(exc).__name__}: {exc}]\n')
        finally:
            current_command_output.reset(token)
            bg.endedAt = _now()
            bg.elapsedMs = max(0, int((time.monotonic() - bg.startedMono) * 1000))
            self._write_meta(bg)

    def _on_done(self, bg: BackgroundCommand) -> None:
        # A stopped command is not a completion to wake a turn for: the Stop
        # button or kill_background_task already gave its killer the receipt.
        if not bg.detached or bg.status == 'killed':
            return
        self._notify(bg)

    # ── tools ───────────────────────────────────────────────────────────
    def list_tasks(self, session_id: str) -> str:
        self._prune_once()
        sessionId = (session_id or 'default').strip() or 'default'
        items = [task for task in self._tasks.values() if task.sessionId == sessionId]
        known = {task.id for task in items}
        for meta in self._load_session_metas(sessionId, skip_ids=known):
            if meta.id not in known:
                items.append(meta)
        if not items:
            return 'No background commands for this session.'
        lines = ['Background commands:']
        for item in sorted(items, key=lambda task: task.startedAt):
            lines.append(
                f'  [{item.id}] {item.status} · {_display_elapsed(item)} · '
                f'{_short_command(item.command, 160)}'
            )
        return '\n'.join(lines)

    def read(self, task_id: str, session_id: str = '', tail_chars: int = _TAIL_DEFAULT) -> str:
        bg = self._find(task_id, session_id)
        if bg is None:
            return f"Error: no background command '{task_id}'."
        if bg.status == 'running' and bg.task is None:
            # Found on disk after a restart: the child may still exist, but we
            # cannot reattach to it or know its exit code.
            bg.status = 'orphaned'
            self._write_meta(bg)
        try:
            tail_chars = int(tail_chars or _TAIL_DEFAULT)
        except (TypeError, ValueError):
            tail_chars = _TAIL_DEFAULT
        tail_chars = max(500, min(tail_chars, 40000))
        tail = self._tail(bg.logPath, tail_chars)
        lines = [
            f'Background command {bg.id}: {bg.status}',
            f'Command: {_short_command(bg.command, 500)}',
            f'Elapsed: {_display_elapsed(bg)}',
        ]
        if bg.exitCode is not None:
            lines.append(f'Exit code: {bg.exitCode}')
        if bg.status == 'running':
            lines.append('Still running — you will be notified when it finishes; do not poll repeatedly.')
        lines.append(f'Log: {bg.logPath}')
        lines.append('')
        lines.append(tail or '(no output yet)')
        return '\n'.join(lines)

    async def kill(self, task_id: str, session_id: str = '') -> str:
        bg = self._find(task_id, session_id)
        if bg is None:
            return f"Error: no background command '{task_id}'."
        if bg.task is None or bg.task.done():
            return f'Background command {bg.id} is already {bg.status}.'
        if not bg.detached:
            return f'Background command {bg.id} is still in its foreground wait; it has not detached yet.'
        bg.task.cancel()
        try:
            await bg.task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 -- task teardown is best-effort
            pass
        return f'Stopped background command {bg.id}.'

    # ── lookup and persistence ──────────────────────────────────────────
    def _find(self, task_id: str, session_id: str = '') -> BackgroundCommand | None:
        if not _valid_task_id(task_id):
            return None
        task = self._tasks.get(task_id)
        if task is not None:
            return task
        live = set(self._tasks)
        for meta in self._load_session_metas(session_id or 'default', skip_ids=live):
            if meta.id == task_id:
                return meta
        # The caller may not know its session id (a restarted process). Scan
        # every session directory for the id; the id is globally unique.
        root = _data_root()
        if root.is_dir():
            for sessionDir in root.iterdir():
                found = self._read_meta(sessionDir / f'{task_id}.json')
                if found is not None and (not session_id or found.sessionId == session_id):
                    if found.status == 'running':
                        found.status = 'orphaned'
                        self._write_meta(found)
                    return found
        return None

    def _load_session_metas(
        self, session_id: str, skip_ids: set[str] | frozenset[str] = frozenset()
    ) -> list[BackgroundCommand]:
        sessionDir = _session_dir(session_id)
        if not sessionDir.is_dir():
            return []
        found: list[BackgroundCommand] = []
        for path in sorted(sessionDir.glob('*.json')):
            meta = self._read_meta(path)
            if meta is None:
                continue
            if meta.id in skip_ids:
                continue
            if meta.status == 'running':
                meta.status = 'orphaned'
                self._write_meta(meta)
            found.append(meta)
        return found

    def _read_meta(self, path: Path) -> BackgroundCommand | None:
        taskId = path.stem
        if not _valid_task_id(taskId):
            return None
        try:
            data = json.loads(path.read_text('utf-8'))
            if not isinstance(data, dict):
                return None
            sessionId = str(data.get('sessionId') or 'default')
            return BackgroundCommand(
                id=taskId,
                sessionId=sessionId,
                command=str(data.get('command') or ''),
                workspace=str(data.get('workspace') or ''),
                # Derive the log path from the meta path; never trust a path
                # stored in a file a user could edit to point at something else.
                logPath=path.with_suffix('.log'),
                metaPath=path,
                startedAt=str(data.get('startedAt') or ''),
                status=str(data.get('status') or 'orphaned'),
                exitCode=data.get('exitCode') if isinstance(data.get('exitCode'), int) else None,
                endedAt=str(data.get('endedAt') or ''),
                elapsedMs=int(data.get('elapsedMs') or 0),
                resultText=str(data.get('resultText') or ''),
                detached=True,
                notified=True,
            )
        except Exception:  # noqa: BLE001 -- one corrupt meta must not stop the listing
            logger.debug('background meta unreadable: %s', path, exc_info=True)
            return None

    def _write_meta(self, bg: BackgroundCommand) -> None:
        payload = {
            'id': bg.id,
            'sessionId': bg.sessionId,
            'command': bg.command[:4000],
            'workspace': bg.workspace,
            'logPath': str(bg.logPath),
            'startedAt': bg.startedAt,
            'endedAt': bg.endedAt,
            'status': bg.status,
            'exitCode': bg.exitCode,
            'elapsedMs': bg.elapsedMs,
        }
        tmp = bg.metaPath.with_suffix('.json.tmp')
        try:
            bg.metaPath.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(json.dumps(payload, ensure_ascii=False), 'utf-8')
            os.replace(tmp, bg.metaPath)
        except Exception:  # noqa: BLE001 -- metadata is best-effort
            logger.debug('background meta write failed: %s', bg.metaPath, exc_info=True)
            try:
                tmp.unlink(missing_ok=True)
            except Exception:  # noqa: BLE001 -- a failure to notify must not kill the task
                pass

    def _append_log(self, bg: BackgroundCommand, text: str) -> None:
        if not text:
            return
        if bg.logBytes >= MAX_LOG_BYTES:
            if not bg.logCapped:
                bg.logCapped = True
                try:
                    with open(bg.logPath, 'a', encoding='utf-8', errors='replace', newline='') as handle:
                        handle.write(f'\n[output capped at {MAX_LOG_BYTES} bytes; further output not stored]\n')
                except OSError:
                    pass
            return
        remaining = MAX_LOG_BYTES - bg.logBytes
        encoded = text.encode('utf-8', errors='replace')
        if len(encoded) > remaining:
            text = encoded[:remaining].decode('utf-8', errors='ignore')
        try:
            with open(bg.logPath, 'a', encoding='utf-8', errors='replace', newline='') as handle:
                handle.write(text)
            bg.logBytes += len(text.encode('utf-8', errors='replace'))
        except OSError:
            logger.debug('background log append failed: %s', bg.logPath, exc_info=True)

    def _tail(self, path: Path, limit: int) -> str:
        try:
            size = path.stat().st_size
            with open(path, 'r', encoding='utf-8', errors='replace', newline='') as handle:
                if size > limit:
                    handle.seek(size - limit)
                    return '…' + handle.read()
                return handle.read()
        except OSError:
            return ''

    def _running_text(self, bg: BackgroundCommand, lead: str) -> str:
        return (
            f'{lead} Background task {bg.id} is still running in the same process — it was '
            f'not restarted. You will be notified when it finishes; do not re-run it.\n'
            f'Inspect: read_background_task("{bg.id}") · stop: kill_background_task("{bg.id}")\n'
            f'Log: {bg.logPath}'
        )

    def _cleanup_files(self, bg: BackgroundCommand) -> None:
        for path in (bg.metaPath, bg.logPath):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.debug('background cleanup failed: %s', path, exc_info=True)

    def _prune_once(self) -> None:
        nowMono = time.monotonic()
        if nowMono - self._lastPrune < 3600.0:
            return
        self._lastPrune = nowMono
        root = _data_root()
        if not root.is_dir():
            return
        cutoff = time.time() - RETENTION_DAYS * 86400
        # Keep a RUNNING task's log no matter how old it is; a completed
        # task's files may age out after the retention window.
        live = {task.id for task in self._tasks.values() if task.status == 'running'}
        for sessionDir in root.iterdir():
            if not sessionDir.is_dir():
                continue
            for path in list(sessionDir.glob('*.json')) + list(sessionDir.glob('*.log')):
                if path.stem in live:
                    continue
                try:
                    if path.stat().st_mtime < cutoff:
                        path.unlink(missing_ok=True)
                except OSError:
                    continue

    async def shutdown(self) -> None:
        tasks = [task for task in self._tasks.values() if task.task is not None and not task.task.done()]
        handles = [task.task for task in tasks if task.task is not None]
        for task in tasks:
            task.silent = True
        for handle in handles:
            handle.cancel()
        if handles:
            await asyncio.gather(*handles, return_exceptions=True)
        self._tasks.clear()

    async def cancel_for_session(self, session_id: str) -> int:
        tasks = [
            task
            for task in self._tasks.values()
            if task.sessionId == session_id and task.task is not None and not task.task.done()
        ]
        handles = [task.task for task in tasks if task.task is not None]
        for task in tasks:
            task.silent = True
        for handle in handles:
            handle.cancel()
        if handles:
            await asyncio.gather(*handles, return_exceptions=True)
        return len(tasks)


_manager: BackgroundCommandManager | None = None


def getManager() -> BackgroundCommandManager:
    global _manager
    if _manager is None:
        _manager = BackgroundCommandManager()
    return _manager


async def shutdownAll() -> None:
    global _manager
    if _manager is not None:
        await _manager.shutdown()
        _manager = None
