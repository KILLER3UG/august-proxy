"""
Scheduler — manages recurring job execution using asyncio.

Port of backend/services/scheduler/index.js + missing/cron-tools.js.
"""

from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_str
from app.lib.paths import dataPath

_JOBSFile = dataPath('scheduled-jobs.json')


def _jobsPath() -> Path:
    return _JOBSFile


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _parseCron(expression: str) -> tuple[list[int], list[int], list[int], list[int], list[int]]:
    """Parse a cron expression into field values.

    Returns (minutes, hours, days_of_month, months, days_of_week).
    Each is a list of matching values.
    """
    fields = expression.strip().split()
    if len(fields) != 5:
        raise ValueError(f'Invalid cron expression: {expression}')

    def parseField(field: str, minVal: int, maxVal: int) -> list[int]:
        if field == '*':
            return list(range(minVal, maxVal + 1))
        values: list[int] = []
        for part in field.split(','):
            if '/' in part:
                base, step = part.split('/')
                start = minVal if base == '*' else int(base)
                values.extend(range(start, maxVal + 1, int(step)))
            elif '-' in part:
                low, high = part.split('-')
                values.extend(range(int(low), int(high) + 1))
            else:
                values.append(int(part))
        return sorted(set((v for v in values if minVal <= v <= maxVal)))

    return (
        parseField(fields[0], 0, 59),
        parseField(fields[1], 0, 23),
        parseField(fields[2], 1, 31),
        parseField(fields[3], 1, 12),
        parseField(fields[4], 0, 6),
    )


def _matchesCron(expr: str, dt: datetime | None = None) -> bool:
    """Check if the current time matches a cron expression."""
    if dt is None:
        dt = datetime.now(timezone.utc)
    minutes, hours, days, months, weekdays = _parseCron(expr)
    return (
        dt.minute in minutes
        and dt.hour in hours
        and (dt.day in days)
        and (dt.month in months)
        and (dt.weekday() in weekdays)
    )


_jobs: dict[str, dict[str, object]] = {}
_tasks: dict[str, asyncio.Task] = {}
_running = False


def _loadJobs() -> None:
    p = _jobsPath()
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text('utf-8'))
        if isinstance(data, list):
            for j in data:
                if j.get('id'):
                    _jobs[j['id']] = j
    except (json.JSONDecodeError, OSError):
        pass


def _saveJobs() -> None:
    p = _jobsPath()
    p.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(p, list(_jobs.values()), indent=2, default=str)


def listJobs() -> list[dict[str, object]]:
    return list(_jobs.values())


def createJob(name: str, schedule: str, command: str, enabled: bool = True) -> dict[str, object]:
    """Create a scheduled job."""
    import uuid

    jobId = f'sch_{uuid.uuid4().hex[:8]}'
    job = {
        'id': jobId,
        'name': name,
        'schedule': schedule,
        'command': command,
        'enabled': enabled,
        'status': 'idle',
        'lastRun': None,
        'nextRun': None,
        'createdAt': _now(),
    }
    _jobs[jobId] = job
    _saveJobs()
    return job


def deleteJob(jobId: str) -> bool:
    if jobId not in _jobs:
        return False
    if jobId in _tasks:
        _tasks[jobId].cancel()
        del _tasks[jobId]
    del _jobs[jobId]
    _saveJobs()
    return True


def updateJob(jobId: str, updates: dict[str, object]) -> dict[str, object] | None:
    if jobId not in _jobs:
        return None
    _jobs[jobId].update(updates)
    _saveJobs()
    return _jobs[jobId]


async def runJobNow(jobId: str) -> dict[str, object]:
    """Execute a job immediately."""
    job = _jobs.get(jobId)
    if not job:
        return {'error': 'Job not found'}
    job['status'] = 'running'
    try:
        from app.lib.async_subprocess import SubprocessAborted, communicate_or_kill

        proc = await asyncio.create_subprocess_shell(
            as_str(job['command'], ''),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            stdin=asyncio.subprocess.DEVNULL,
        )
        stdout, stderr = await communicate_or_kill(proc, timeout=300)
        job['lastRun'] = _now()
        job['status'] = 'idle'
        job['lastResult'] = stdout.decode('utf-8', errors='replace')[:1000]
        if proc.returncode != 0:
            job['lastError'] = stderr.decode('utf-8', errors='replace')[:500]
        _saveJobs()
        return job
    except SubprocessAborted:
        job['status'] = 'error'
        job['lastError'] = 'Timeout'
        return job
    except Exception as exc:
        job['status'] = 'error'
        job['lastError'] = str(exc)
        return job


def _make_done_callback(job_id: str) -> Callable[[asyncio.Task], None]:
    """Return a callback that removes *job_id* from ``_tasks`` when done."""

    def _cleanup(t: asyncio.Task) -> None:
        _tasks.pop(job_id, None)

    return _cleanup


async def startScheduler(intervalS: int = 60) -> None:
    """Start the scheduler loop.

    Fires legacy ``scheduled-jobs.json`` cron jobs and due ``automations.json``
    jobs (enabled, not paused) each tick.
    """
    global _running
    if _running:
        return
    _running = True
    _loadJobs()
    try:
        from app.services import automations_store as automations

        await automations.boot_automations()
    except Exception:
        pass
    while _running:
        now = datetime.now(timezone.utc)
        for jobId, job in list(_jobs.items()):
            if not job.get('enabled'):
                continue
            if _matchesCron(as_str(job.get('schedule'), '* * * * *'), now):
                task = asyncio.create_task(runJobNow(jobId))
                _tasks[jobId] = task
                task.add_done_callback(_make_done_callback(jobId))
        try:
            from app.services import automations_store as automations

            await automations.tick_automations(now=now)
        except Exception:
            pass
        await asyncio.sleep(intervalS)


def stopScheduler() -> None:
    global _running
    _running = False
    for t in _tasks.values():
        t.cancel()
    _tasks.clear()


class Scheduler:
    """v2: In-process scheduler for cognitive-layer tasks.

    - register_periodic: run `fn` every `interval_seconds`
    - register_idle: run `fn` when no activity for `idle_threshold_seconds`
    - record_activity: reset the idle timer (call from workbench on each turn)
    """

    def __init__(self):
        self._periodic: list[tuple[str, Callable[[], Awaitable[None]], float]] = []
        self._idle: list[tuple[str, Callable[[], Awaitable[None]], float]] = []
        self._periodicTasks: list[asyncio.Task] = []
        self._idleTask: asyncio.Task | None = None
        self._stopped = False
        self._lastActivity: float = time.monotonic()
        self._last_activity: float = self._lastActivity
        self._idleResets: int = 0
        self._idle_resets: int = 0

    def registerPeriodic(
        self,
        name: str,
        fn: Callable[[], Awaitable[None]],
        intervalSeconds: float | None = None,
        *,
        interval_seconds: float | None = None,
    ) -> None:
        """Register a task to run every interval seconds."""
        interval = intervalSeconds if intervalSeconds is not None else interval_seconds
        if interval is None:
            raise TypeError('intervalSeconds is required')
        self._periodic.append((name, fn, float(interval)))

    def registerIdle(
        self,
        name: str,
        fn: Callable[[], Awaitable[None]],
        idleThresholdSeconds: float | None = None,
        *,
        idle_threshold_seconds: float | None = None,
    ) -> None:
        """Register a task to run when no activity for the idle threshold."""
        threshold = idleThresholdSeconds if idleThresholdSeconds is not None else idle_threshold_seconds
        if threshold is None:
            threshold = 300.0
        self._idle.append((name, fn, float(threshold)))

    # Snake_case aliases (tests + cognitive_boot)
    register_periodic = registerPeriodic
    register_idle = registerIdle
    registerInterval = registerPeriodic
    register_interval = registerPeriodic

    def recordActivity(self, sessionId: str = '') -> None:
        """Reset the idle timer. Called by workbench on each turn."""
        now = time.monotonic()
        self._lastActivity = now
        self._last_activity = now
        self._idleResets += 1
        self._idle_resets += 1

    record_activity = recordActivity

    async def start(self) -> None:
        """Boot the scheduler. Idempotent."""
        if self._periodicTasks or self._idleTask:
            return
        for name, fn, interval in self._periodic:
            t = asyncio.create_task(self._periodicLoop(name, fn, interval))
            self._periodicTasks.append(t)
        if self._idle:
            self._idleTask = asyncio.create_task(self._idleLoop())

    async def stop(self) -> None:
        """Stop all scheduled tasks."""
        self._stopped = True
        for t in self._periodicTasks:
            t.cancel()
        if self._idleTask:
            self._idleTask.cancel()
        awaitableTasks = [t for t in self._periodicTasks if t is not None]
        if self._idleTask is not None:
            awaitableTasks.append(self._idleTask)
        if awaitableTasks:
            await asyncio.gather(*awaitableTasks, return_exceptions=True)
        self._periodicTasks = []
        self._idleTask = None

    async def _periodicLoop(self, name: str, fn: Callable[[], Awaitable[None]], interval: float) -> None:
        while not self._stopped:
            try:
                await fn()
            except Exception:
                pass
            await asyncio.sleep(interval)

    async def _idleLoop(self) -> None:
        """Wake near the next idle deadline instead of polling every 100ms."""
        while not self._stopped:
            if not self._idle:
                await asyncio.sleep(1.0)
                continue
            now = time.monotonic()
            earliest_due: float | None = None
            fired = False
            for _name, fn, threshold in self._idle:
                due_at = self._lastActivity + threshold
                if now >= due_at:
                    try:
                        await fn()
                    except Exception:
                        pass
                    self._lastActivity = time.monotonic()
                    fired = True
                    break
                if earliest_due is None or due_at < earliest_due:
                    earliest_due = due_at
            if fired:
                continue
            sleep_for = 1.0 if earliest_due is None else max(0.05, earliest_due - time.monotonic())
            await asyncio.sleep(sleep_for)
