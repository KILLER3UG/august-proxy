"""
Scheduler — manages recurring job execution using asyncio.

Port of backend/services/scheduler/index.js + missing/cron-tools.js.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.lib.paths import data_path

_JOBS_FILE = data_path("scheduled-jobs.json")


def _jobs_path() -> Path:
    return _JOBS_FILE


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _parse_cron(expression: str) -> tuple[list[int], list[int], list[int], list[int], list[int]]:
    """Parse a cron expression into field values.

    Returns (minutes, hours, days_of_month, months, days_of_week).
    Each is a list of matching values.
    """
    fields = expression.strip().split()
    if len(fields) != 5:
        raise ValueError(f"Invalid cron expression: {expression}")

    def parse_field(field: str, min_val: int, max_val: int) -> list[int]:
        if field == "*":
            return list(range(min_val, max_val + 1))
        values = []
        for part in field.split(","):
            if "/" in part:
                base, step = part.split("/")
                start = min_val if base == "*" else int(base)
                values.extend(range(start, max_val + 1, int(step)))
            elif "-" in part:
                low, high = part.split("-")
                values.extend(range(int(low), int(high) + 1))
            else:
                values.append(int(part))
        return sorted(set(v for v in values if min_val <= v <= max_val))

    return (
        parse_field(fields[0], 0, 59),
        parse_field(fields[1], 0, 23),
        parse_field(fields[2], 1, 31),
        parse_field(fields[3], 1, 12),
        parse_field(fields[4], 0, 6),
    )


def _matches_cron(expr: str, dt: datetime | None = None) -> bool:
    """Check if the current time matches a cron expression."""
    if dt is None:
        dt = datetime.utcnow()
    minutes, hours, days, months, weekdays = _parse_cron(expr)
    return (
        dt.minute in minutes
        and dt.hour in hours
        and dt.day in days
        and dt.month in months
        and dt.weekday() in weekdays
    )


# ── Job store ─────────────────────────────────────────────────────────

_jobs: dict[str, dict[str, Any]] = {}
_tasks: dict[str, asyncio.Task] = {}
_running = False


def _load_jobs() -> None:
    p = _jobs_path()
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text("utf-8"))
        if isinstance(data, list):
            for j in data:
                if j.get("id"):
                    _jobs[j["id"]] = j
    except (json.JSONDecodeError, OSError):
        pass


def _save_jobs() -> None:
    p = _jobs_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(list(_jobs.values()), indent=2, default=str), "utf-8")


# ── Public API ────────────────────────────────────────────────────────


def list_jobs() -> list[dict[str, Any]]:
    return list(_jobs.values())


def create_job(name: str, schedule: str, command: str, enabled: bool = True) -> dict[str, Any]:
    """Create a scheduled job."""
    import uuid
    job_id = f"sch_{uuid.uuid4().hex[:8]}"
    job = {
        "id": job_id, "name": name, "schedule": schedule, "command": command,
        "enabled": enabled, "status": "idle", "lastRun": None, "nextRun": None,
        "createdAt": _now(),
    }
    _jobs[job_id] = job
    _save_jobs()
    return job


def delete_job(job_id: str) -> bool:
    if job_id not in _jobs:
        return False
    if job_id in _tasks:
        _tasks[job_id].cancel()
        del _tasks[job_id]
    del _jobs[job_id]
    _save_jobs()
    return True


def update_job(job_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    if job_id not in _jobs:
        return None
    _jobs[job_id].update(updates)
    _save_jobs()
    return _jobs[job_id]


async def run_job_now(job_id: str) -> dict[str, Any]:
    """Execute a job immediately."""
    job = _jobs.get(job_id)
    if not job:
        return {"error": "Job not found"}
    job["status"] = "running"
    try:
        import subprocess
        import shlex
        proc = await asyncio.create_subprocess_shell(
            job["command"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        job["lastRun"] = _now()
        job["status"] = "idle"
        job["lastResult"] = stdout.decode("utf-8", errors="replace")[:1000]
        if proc.returncode != 0:
            job["lastError"] = stderr.decode("utf-8", errors="replace")[:500]
        _save_jobs()
        return job
    except asyncio.TimeoutError:
        job["status"] = "error"
        job["lastError"] = "Timeout"
        return job
    except Exception as exc:
        job["status"] = "error"
        job["lastError"] = str(exc)
        return job


async def start_scheduler(interval_s: int = 60) -> None:
    """Start the scheduler loop."""
    global _running
    if _running:
        return
    _running = True
    _load_jobs()

    while _running:
        now = datetime.utcnow()
        for job_id, job in list(_jobs.items()):
            if not job.get("enabled"):
                continue
            if _matches_cron(job.get("schedule", "* * * * *"), now):
                task = asyncio.create_task(run_job_now(job_id))
                _tasks[job_id] = task
                task.add_done_callback(lambda t, j_id=job_id: _tasks.pop(j_id, None))
        await asyncio.sleep(interval_s)


def stop_scheduler() -> None:
    global _running
    _running = False
    for t in _tasks.values():
        t.cancel()
    _tasks.clear()


# ── v2: Cognitive-layer Scheduler ──────────────────────────────────────
# The Scheduler class below provides in-process periodic + idle-triggered
# task execution for v2 cognitive layers (consolidation, timeline sweep,
# delta engine batch flush). It does NOT replace the cron-based scheduler
# above; both coexist.


class Scheduler:
    """v2: In-process scheduler for cognitive-layer tasks.

    - register_periodic: run `fn` every `interval_seconds`
    - register_idle: run `fn` when no activity for `idle_threshold_seconds`
    - record_activity: reset the idle timer (call from workbench on each turn)
    """

    def __init__(self):
        self._periodic: list[tuple[str, Callable[[], Awaitable[None]], float]] = []
        self._idle: list[tuple[str, Callable[[], Awaitable[None]], float]] = []
        self._periodic_tasks: list[asyncio.Task] = []
        self._idle_task: asyncio.Task | None = None
        self._stopped = False
        self._last_activity: float = time.monotonic()
        self._idle_resets: int = 0

    def register_periodic(self, name: str, fn: Callable[[], Awaitable[None]],
                          interval_seconds: float) -> None:
        """Register a task to run every `interval_seconds`."""
        self._periodic.append((name, fn, interval_seconds))

    def register_idle(self, name: str, fn: Callable[[], Awaitable[None]],
                      idle_threshold_seconds: float = 300.0) -> None:
        """Register a task to run when no activity for `idle_threshold_seconds`."""
        self._idle.append((name, fn, idle_threshold_seconds))

    def record_activity(self, session_id: str) -> None:
        """Reset the idle timer. Called by workbench on each turn."""
        self._last_activity = time.monotonic()
        self._idle_resets += 1

    async def start(self) -> None:
        """Boot the scheduler. Idempotent."""
        if self._periodic_tasks or self._idle_task:
            return
        for name, fn, interval in self._periodic:
            t = asyncio.create_task(self._periodic_loop(name, fn, interval))
            self._periodic_tasks.append(t)
        if self._idle:
            self._idle_task = asyncio.create_task(self._idle_loop())

    async def stop(self) -> None:
        """Stop all scheduled tasks."""
        self._stopped = True
        for t in self._periodic_tasks:
            t.cancel()
        if self._idle_task:
            self._idle_task.cancel()
        # Filter out None to avoid gather errors when no idle task was started
        awaitable_tasks = [t for t in self._periodic_tasks if t is not None]
        if self._idle_task is not None:
            awaitable_tasks.append(self._idle_task)
        if awaitable_tasks:
            await asyncio.gather(*awaitable_tasks, return_exceptions=True)
        self._periodic_tasks = []
        self._idle_task = None

    async def _periodic_loop(self, name: str, fn: Callable[[], Awaitable[None]],
                              interval: float) -> None:
        while not self._stopped:
            try:
                await fn()
            except Exception:
                pass
            await asyncio.sleep(interval)

    async def _idle_loop(self) -> None:
        # Use a short check interval (100ms) so the threshold check
        # happens frequently; the actual fire rate is gated by `threshold`.
        check_interval = 0.1
        while not self._stopped:
            for name, fn, threshold in self._idle:
                if time.monotonic() - self._last_activity >= threshold:
                    try:
                        await fn()
                    except Exception:
                        pass
                    self._last_activity = time.monotonic()
            await asyncio.sleep(check_interval)
