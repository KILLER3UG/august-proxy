"""Long-running harness jobs (distinct from a chat turn)."""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any

from app.json_narrowing import as_str

logger = logging.getLogger(__name__)


def _conn():
    from app.services.memory_store import _conn as mem_conn

    return mem_conn()


def create_job(
    session_id: str,
    *,
    waves: list[list[dict[str, Any]]] | None = None,
    work_items: list[dict[str, Any]] | None = None,
) -> str:
    job_id = f'job_{uuid.uuid4().hex[:12]}'
    conn = _conn()
    conn.execute(
        'INSERT INTO harness_jobs (id, session_id, status, waves_json, work_items_json, created_at) '
        'VALUES (?, ?, ?, ?, ?, ?)',
        (
            job_id,
            session_id,
            'running',
            json.dumps(_wave_names(waves or []), ensure_ascii=False),
            json.dumps(work_items or [], ensure_ascii=False, default=str)[:20000],
            time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        ),
    )
    conn.commit()
    return job_id


def _wave_names(waves: list[list[dict[str, Any]]]) -> list[list[str]]:
    from app.services.workstreams import item_name

    out: list[list[str]] = []
    for wave in waves:
        names: list[str] = []
        for i, item in enumerate(wave):
            try:
                names.append(item_name(item, i))
            except Exception:
                names.append(as_str(item.get('goal'), '')[:40] or f'item_{i}')
        out.append(names)
    return out


def _ensure_outcomes_col(conn) -> None:
    try:
        conn.execute("ALTER TABLE harness_jobs ADD COLUMN outcomes_json TEXT DEFAULT '{}'")
        conn.commit()
    except Exception:
        pass


def record_lane(job_id: str, name: str, status: str, error: str = '', task_id: str = '') -> None:
    if not job_id or not name:
        return
    try:
        conn = _conn()
        _ensure_outcomes_col(conn)
        row = conn.execute('SELECT outcomes_json FROM harness_jobs WHERE id = ?', (job_id,)).fetchone()
        if not row:
            return
        raw = {}
        try:
            loaded = json.loads(row['outcomes_json'] or '{}')
            if isinstance(loaded, dict):
                raw = loaded
        except Exception:
            raw = {}
        prev_item = raw.get(name) if isinstance(raw, dict) else None
        prev: dict[str, Any] = prev_item if isinstance(prev_item, dict) else {}
        raw[name] = {
            'status': status,
            'error': error[:400],
            'taskId': task_id or as_str(prev.get('taskId'), ''),
        }
        conn.execute(
            'UPDATE harness_jobs SET outcomes_json = ? WHERE id = ?',
            (json.dumps(raw, ensure_ascii=False), job_id),
        )
        conn.commit()
    except Exception:
        logger.debug('record_lane failed', exc_info=True)


def _parse_outcomes(row: Any) -> dict[str, Any]:
    try:
        raw = json.loads(row['outcomes_json'] or '{}')
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def attach_task(job_id: str, task_id: str) -> None:
    if not job_id or not task_id:
        return
    try:
        conn = _conn()
        row = conn.execute('SELECT task_ids FROM harness_jobs WHERE id = ?', (job_id,)).fetchone()
        if not row:
            return
        ids = json.loads(row['task_ids'] or '[]')
        if not isinstance(ids, list):
            ids = []
        if task_id not in ids:
            ids.append(task_id)
        conn.execute('UPDATE harness_jobs SET task_ids = ? WHERE id = ?', (json.dumps(ids), job_id))
        conn.commit()
    except Exception:
        logger.debug('attach_task failed', exc_info=True)


def finish_job(job_id: str, status: str, *, dirty: bool = False, error: str = '') -> None:
    if not job_id:
        return
    try:
        conn = _conn()
        conn.execute(
            'UPDATE harness_jobs SET status = ?, dirty = ?, error = ?, finished_at = ? WHERE id = ?',
            (
                status,
                1 if dirty else 0,
                (error or '')[:2000],
                time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                job_id,
            ),
        )
        conn.commit()
    except Exception:
        logger.debug('finish_job failed', exc_info=True)


def mark_dirty(job_id: str, note: str = '') -> None:
    if not job_id:
        return
    try:
        conn = _conn()
        conn.execute(
            'UPDATE harness_jobs SET dirty = 1, error = CASE WHEN error = "" OR error IS NULL THEN ? ELSE error END WHERE id = ?',
            (note[:2000] or 'Worker mutated the environment then exited without a clean episode.', job_id),
        )
        conn.commit()
    except Exception:
        logger.debug('mark_dirty failed', exc_info=True)


def _row_to_job(r: Any) -> dict[str, Any]:
    try:
        waves = json.loads(r['waves_json'] or '[]')
    except Exception:
        waves = []
    try:
        tasks = json.loads(r['task_ids'] or '[]')
    except Exception:
        tasks = []
    return {
        'id': r['id'],
        'sessionId': r['session_id'],
        'status': r['status'],
        'dirty': bool(r['dirty']),
        'error': r['error'] or '',
        'waves': waves,
        'taskIds': tasks,
        'outcomes': _parse_outcomes(r),
        'createdAt': r['created_at'],
        'finishedAt': r['finished_at'],
    }


def list_jobs(session_id: str, *, limit: int = 30) -> list[dict[str, Any]]:
    conn = _conn()
    _ensure_outcomes_col(conn)
    rows = conn.execute(
        'SELECT id, session_id, status, dirty, error, waves_json, task_ids, outcomes_json, created_at, finished_at '
        'FROM harness_jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
        (session_id, limit),
    ).fetchall()
    return [_row_to_job(r) for r in rows]


def get_job(job_id: str) -> dict[str, Any] | None:
    conn = _conn()
    _ensure_outcomes_col(conn)
    r = conn.execute(
        'SELECT id, session_id, status, dirty, error, waves_json, task_ids, outcomes_json, created_at, finished_at '
        'FROM harness_jobs WHERE id = ?',
        (job_id,),
    ).fetchone()
    if not r:
        return None
    return _row_to_job(r)


async def cancel_job(job_id: str) -> dict[str, Any]:
    job = get_job(job_id)
    if not job:
        return {'status': 'error', 'error': 'job not found'}
    from app.services.runtime_services import get_orchestrator

    orch = get_orchestrator()
    stopped = 0
    for tid in job.get('taskIds') or []:
        try:
            if await orch.terminate(str(tid)):
                stopped += 1
        except Exception:
            pass
    finish_job(job_id, 'cancelled')
    return {'status': 'cancelled', 'jobId': job_id, 'stopped': stopped}


async def cancel_wave(job_id: str, wave_index: int) -> dict[str, Any]:
    job = get_job(job_id)
    if not job:
        return {'status': 'error', 'error': 'job not found'}
    waves = job.get('waves') or []
    if wave_index < 0 or wave_index >= len(waves):
        return {'status': 'error', 'error': 'wave not found'}
    names = [n for n in (waves[wave_index] or []) if n]
    outcomes = job.get('outcomes') or {}
    from app.services.runtime_services import get_orchestrator

    orch = get_orchestrator()
    stopped = 0
    for name in names:
        info_item = outcomes.get(name) if isinstance(outcomes, dict) else None
        info: dict[str, Any] = info_item if isinstance(info_item, dict) else {}
        tid = as_str(info.get('taskId'), '')
        st = as_str(info.get('status'), '')
        if tid and st in ('running', 'pending', ''):
            try:
                if await orch.terminate(tid):
                    stopped += 1
            except Exception:
                pass
        record_lane(job_id, name, 'cancelled', 'Stopped with this wave', tid)
    return {'status': 'ok', 'jobId': job_id, 'wave': wave_index, 'stopped': stopped, 'names': names}
