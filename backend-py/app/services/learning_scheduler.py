"""P2 — the unified learning scheduler.

Before this module, the background learning loop rode three independent
pollers: ``scheduled_introspection_loop`` (fixed 6h, started in main.py),
``consolidation_loop`` (brain-config cadence, started in cognitive_boot,
itself carrying the distiller + refine passes), and in-turn ReviewGates
(which stay in-turn by design — they react to conversation, not the clock).
Each poller kept its own due/no-op bookkeeping (or none at all), logged its
own failures, and the UI could not answer "when did the learning brain last
run, and what did it do?"

This module collapses the *scheduled* pollers into one registry + one loop:

* One table — ``learning_job_run`` (migration 041) — is the ledger. Every
  run gets a row with status, duration and a small summary blob.
* Due-ness is computed from the ledger (last finished run + interval),
  so state survives restarts and there is exactly one overdue path, the
  one ``consolidation_loop`` used to implement by hand.
* Cadences are re-read from brain-config every tick, so a settings change
  takes effect without a restart (same behavior the loops had individually).
* ``run_job(name)`` is the manual entry point (router / debugging) and
  writes the same ledger rows as the scheduler.

The job bodies are thin adapters over the existing passes — introspection
filing, promotion judging, and the whole consolidation chain (memory
lifecycle + skill learning + distiller + refine) — so this is a wiring
change, not a behavior change. The old loop functions remain importable as
shims for one release; nothing starts them anymore.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

logger = logging.getLogger(__name__)

# Ledger retention: keep the recent tail, prune the rest. The scheduler and
# the panel read at most the last few rows per job.
_LEDGER_KEEP_PER_JOB = 50

# Tick granularity. Small vs 6h/24h cadences; cheap vs a SELECT on the ledger.
_TICK_S = 60


def _conn():
    from app.services.memory_conn import conn

    return conn()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat(timespec='seconds')


# ── Ledger ────────────────────────────────────────────────────────────────


def _ensure_ledger() -> None:
    """Migration 041 creates the table at schema init; cover contexts that
    touch the scheduler before a full init (tests, scripts)."""
    conn = _conn()
    conn.execute(
        "CREATE TABLE IF NOT EXISTS learning_job_run ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  job TEXT NOT NULL,"
        "  started_at TEXT NOT NULL,"
        "  finished_at TEXT,"
        "  status TEXT NOT NULL DEFAULT 'running',"
        "  duration_s REAL,"
        "  detail TEXT)"
    )
    conn.execute(
        'CREATE INDEX IF NOT EXISTS idx_learning_job_run_job '
        'ON learning_job_run(job, id)'
    )
    conn.commit()


def _prune(conn) -> None:
    """Cap the ledger at the recent tail per job (id is monotonic)."""
    conn.execute(
        'DELETE FROM learning_job_run WHERE id NOT IN ('
        '  SELECT id FROM learning_job_run l2'
        '  WHERE l2.job = learning_job_run.job'
        f'  ORDER BY id DESC LIMIT {_LEDGER_KEEP_PER_JOB})'
    )


def _start_run(job: str) -> int:
    conn = _conn()
    cur = conn.execute(
        "INSERT INTO learning_job_run (job, started_at, status) VALUES (?, ?, 'running')",
        (job, _iso(_utcnow())),
    )
    conn.commit()
    return int(cur.lastrowid or 0)


def _finish_run(run_id: int, status: str, detail: dict[str, Any]) -> None:
    conn = _conn()
    row = conn.execute(
        'SELECT started_at FROM learning_job_run WHERE id = ?', (run_id,)
    ).fetchone()
    started = str(row['started_at']) if row else ''
    dur: float | None = None
    if started:
        try:
            dur = (_utcnow() - datetime.fromisoformat(started)).total_seconds()
        except ValueError:
            dur = None
    conn.execute(
        'UPDATE learning_job_run SET finished_at = ?, status = ?, duration_s = ?, detail = ?'
        ' WHERE id = ?',
        (_iso(_utcnow()), status, dur, json.dumps(detail, default=str)[:2000], run_id),
    )
    _prune(conn)
    conn.commit()


def last_run(job: str) -> dict[str, Any] | None:
    """The most recent FINISHED ledger row for a job, or None."""
    conn = _conn()
    row = conn.execute(
        "SELECT * FROM learning_job_run WHERE job = ? AND status != 'running'"
        ' ORDER BY id DESC LIMIT 1',
        (job,),
    ).fetchone()
    return dict(row) if row else None


def recent_runs(limit: int = 20) -> list[dict[str, Any]]:
    conn = _conn()
    rows = conn.execute(
        'SELECT job, started_at, finished_at, status, duration_s, detail'
        ' FROM learning_job_run ORDER BY id DESC LIMIT ?',
        ((max(1, min(int(limit), 200))),),
    ).fetchall()
    return [dict(r) for r in rows]


# ── Registry ──────────────────────────────────────────────────────────────


class Job:
    def __init__(
        self,
        name: str,
        fn: Callable[[], dict[str, Any]],
        interval_hours: Callable[[], float],
    ) -> None:
        self.name = name
        self.fn = fn
        self._interval_hours = interval_hours

    def interval(self) -> float:
        try:
            h = float(self._interval_hours())
        except Exception:
            h = 24.0
        return min(max(h, 1.0), 168.0)

    def due(self) -> bool:
        """First boot (no ledger row) is always due; otherwise overdue vs the
        last finished run. Running rows never make the job due twice."""
        row = last_run(self.name)
        if row is None:
            return True
        try:
            finished = datetime.fromisoformat(str(row['finished_at']))
        except (TypeError, ValueError):
            return True
        if finished.tzinfo is None:
            finished = finished.replace(tzinfo=timezone.utc)
        return (_utcnow() - finished).total_seconds() >= self.interval() * 3600


JOBS: dict[str, Job] = {}


def _register(job: Job) -> None:
    JOBS[job.name] = job


# ── Cadence config ────────────────────────────────────────────────────────


def _config_interval(key: str, default: float) -> Callable[[], float]:
    def _get() -> float:
        try:
            from app.services.brain_config_service import getRuntimeConfig

            raw = getRuntimeConfig().get(key, default)
            return float(raw if isinstance(raw, (int, float, str)) else default)
        except Exception:
            return default

    return _get


# ── Job bodies (adapters over the existing passes) ────────────────────────


def _introspection_job() -> dict[str, Any]:
    from app.services.harness_self_improve import (
        _run_scheduled_pass,
        _run_scheduled_promotion_pass,
    )

    filed = _run_scheduled_pass()
    promoted = _run_scheduled_promotion_pass()
    return {'observationsFiled': filed, 'promotionsFiled': promoted}


def _consolidation_job() -> dict[str, Any]:
    from app.services.memory_store.consolidation import run_consolidation

    summary = run_consolidation()
    # Keep the ledger row compact: the full summary can carry long blobs.
    return {k: v for k, v in summary.items() if not isinstance(v, (list, tuple))}


def _outcome_job() -> dict[str, Any]:
    """P5: measure due harness_outcome rows (pre/post episode stats)."""
    from app.services.harness_outcome import measure_pending

    return measure_pending()


def _refine_job() -> dict[str, Any]:
    """The gated refine pass as its OWN cadence.

    It used to ride inside _skill_learning_pass (consolidation, 24h): a
    refine batch could only land when memory consolidation ran, and its
    ledger row hid inside the consolidation blob. As a first-class job it
    gets its own due-ness, its own ledger row, and its own run-now button —
    and _skill_learning_pass no longer calls it (see consolidation.py).
    """
    from app.services.refine_store import get_refine_config, run_scheduled_refine

    if not get_refine_config()['autoRefine']:
        return {'status': 'disabled'}
    out = run_scheduled_refine()
    # Compact ledger row: keep status + counts, drop the raw model output
    # blob (the applied list lives in the refine journal, not here).
    detail = {k: v for k, v in out.items() if k != 'result'}
    result = out.get('result')
    if isinstance(result, dict) and isinstance(result.get('applied'), list):
        detail['applied'] = len(result['applied'])
    return detail


_register(Job('introspection', _introspection_job, _config_interval('introspectionIntervalHours', 6.0)))
_register(Job('consolidation', _consolidation_job, _config_interval('consolidationIntervalHours', 24.0)))
_register(Job('refine', _refine_job, _config_interval('refineIntervalHours', 24.0)))
_register(Job('outcome', _outcome_job, _config_interval('outcomeIntervalHours', 72.0)))


# ── Execution ─────────────────────────────────────────────────────────────


def run_job(name: str) -> dict[str, Any]:
    """One synchronous pass of a registered job with ledger bookkeeping.
    Never raises: failures land in the ledger as status='error'."""
    _ensure_ledger()
    job = JOBS.get(name)
    if job is None:
        return {'ok': False, 'error': f'unknown job {name!r}'}
    run_id = _start_run(name)
    started = time.monotonic()
    try:
        detail = job.fn()
        status = 'ok'
        if isinstance(detail, dict) and detail.get('error'):
            status = 'error'
    except Exception as exc:  # defensive: adapters should not raise
        logger.warning('learning job %s failed', name, exc_info=True)
        detail = {'error': str(exc)[:300]}
        status = 'error'
    _finish_run(run_id, status, detail if isinstance(detail, dict) else {'result': detail})
    return {
        'ok': status == 'ok',
        'job': name,
        'runId': run_id,
        'status': status,
        'durationS': round(time.monotonic() - started, 3),
        'detail': detail,
    }


async def run_job_async(name: str) -> dict[str, Any]:
    """Event-loop-safe wrapper (job bodies are blocking, sync passes)."""
    return await asyncio.to_thread(run_job, name)


async def scheduler_loop() -> None:
    """The one scheduled learning poller. Each tick: every registered job
    that is due runs once, serially (learning passes are cheap individually
    and serialize safely against the shared brain DB)."""
    _ensure_ledger()
    while True:
        try:
            for job in list(JOBS.values()):
                if job.due():
                    await run_job_async(job.name)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug('learning scheduler tick failed', exc_info=True)
        await asyncio.sleep(_TICK_S)


# ── Status for the UI ─────────────────────────────────────────────────────


def scheduler_status() -> dict[str, Any]:
    """Per-job cadence + last-run view, plus the shared recent ledger.
    Cheap: no model calls, a handful of SELECTs."""
    _ensure_ledger()
    now = _utcnow()
    jobs: list[dict[str, Any]] = []
    for job in JOBS.values():
        row = last_run(job.name)
        next_due: str | None = None
        if row and row.get('finished_at'):
            try:
                finished = datetime.fromisoformat(str(row['finished_at']))
                if finished.tzinfo is None:
                    finished = finished.replace(tzinfo=timezone.utc)
                next_due = _iso(finished + timedelta(hours=job.interval()))
            except ValueError:
                pass
        elif row is None:
            next_due = _iso(now)  # never run — due now
        detail: dict[str, Any] = {}
        if row and row.get('detail'):
            try:
                detail = json.loads(row['detail'])
            except (json.JSONDecodeError, TypeError):
                detail = {}
        jobs.append(
            {
                'job': job.name,
                'intervalHours': job.interval(),
                'lastRunAt': row.get('finished_at') if row else None,
                'lastStatus': row.get('status') if row else 'never',
                'lastDurationS': row.get('duration_s') if row else None,
                'nextDueAt': next_due,
                'summary': detail,
            }
        )
    return {'jobs': jobs, 'runs': recent_runs(limit=10)}
