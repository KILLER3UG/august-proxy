"""Durable automations store — atomic JSON under data/automations.json.

Writes are serialized with ``asyncio.Lock`` held only for each individual
load → mutate → write_json_atomic cycle — never across workbench streaming
or other long I/O.

Job types: shell | workbench | http | noop
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Final

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_bool, as_dict, as_float, as_list, as_str
from app.lib.paths import dataPath
from app.services.automations_schedule import (
    compute_next_run_at,
    is_due,
    parse_schedule,
    system_local_timezone,
)

logger = logging.getLogger(__name__)

_FILE = 'automations.json'
_jobs: dict[str, dict[str, object]] | None = None
_jobs_path_key: str | None = None
_lock = asyncio.Lock()

JOB_TYPES: Final[frozenset[str]] = frozenset({'shell', 'workbench', 'http', 'noop'})
DEFAULT_JOB_TYPE = 'workbench'
MAX_RUNS = 20
STALE_RUNNING_MINUTES = 30

Mutator = Callable[[dict[str, dict[str, object]]], object]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path():
    return dataPath(_FILE)


def reset_store() -> None:
    """Test helper — drop process cache so next load re-reads disk."""
    global _jobs, _jobs_path_key
    _jobs = None
    _jobs_path_key = None


def _normalize_job_type(raw: object) -> str:
    t = as_str(raw, DEFAULT_JOB_TYPE).strip().lower() or DEFAULT_JOB_TYPE
    if t not in JOB_TYPES:
        return DEFAULT_JOB_TYPE
    return t


def _new_trigger_token() -> str:
    return secrets.token_urlsafe(24)


def _load() -> dict[str, dict[str, object]]:
    global _jobs, _jobs_path_key
    path = _path()
    key = str(path)
    if _jobs is not None and _jobs_path_key == key:
        return _jobs
    _jobs = {}
    _jobs_path_key = key
    if path.exists():
        try:
            import json

            raw = json.loads(path.read_text('utf-8'))
            for item in as_list(raw.get('jobs') if isinstance(raw, dict) else raw):
                d = as_dict(item)
                jid = as_str(d.get('id'))
                if jid:
                    d = _normalize_job_dict(d)
                    _jobs[jid] = d
        except Exception:
            _jobs = {}
    return _jobs


def _normalize_job_dict(d: dict[str, object]) -> dict[str, object]:
    if 'jobType' not in d and 'job_type' not in d:
        if as_str(d.get('prompt')):
            d['jobType'] = 'workbench'
        elif as_str(d.get('command') or d.get('task')):
            d['jobType'] = 'shell'
        else:
            d['jobType'] = 'noop'
    else:
        d['jobType'] = _normalize_job_type(d.get('jobType') or d.get('job_type'))
    d.pop('job_type', None)
    if 'paused' not in d:
        d['paused'] = False
    if 'timezone' not in d or not as_str(d.get('timezone')):
        d['timezone'] = system_local_timezone()
    if 'runs' not in d or not isinstance(d.get('runs'), list):
        d['runs'] = []
    if 'triggerToken' not in d or not as_str(d.get('triggerToken')):
        d['triggerToken'] = _new_trigger_token()
    if 'enabled' not in d:
        d['enabled'] = True
    return d


def _save() -> None:
    jobs = list(_load().values())
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, {'jobs': jobs, 'updatedAt': _now()}, indent=2)


async def _mutate(mutator: Mutator) -> object:
    """Hold the lock only for load → mutate → write."""
    async with _lock:
        store = _load()
        result = mutator(store)
        _save()
        return result


def _run_coro_sync(coro: Awaitable[object]) -> object:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)  # type: ignore[arg-type]
    raise RuntimeError('sync store helper called from async context; use the async API')


def list_jobs() -> list[dict[str, object]]:
    return [dict(j) for j in _load().values()]


def get_job(job_id: str) -> dict[str, object] | None:
    job = _load().get(job_id)
    return dict(job) if job else None


def _merge_upsert(store: dict[str, dict[str, object]], job: dict[str, object]) -> dict[str, object]:
    jid = as_str(job.get('id')) or f'auto_{uuid.uuid4().hex[:10]}'
    existing = store.get(jid) or {}
    creating = jid not in store
    raw_type = job.get('jobType') if 'jobType' in job else job.get('job_type')
    if raw_type is not None and as_str(raw_type).strip():
        candidate = as_str(raw_type).strip().lower()
        if candidate not in JOB_TYPES:
            raise ValueError(f'unknown jobType {candidate!r}; expected one of {sorted(JOB_TYPES)}')
        job_type = candidate
    else:
        job_type = _normalize_job_type(
            existing.get('jobType') or existing.get('job_type') or DEFAULT_JOB_TYPE
        )
    tz = as_str(job.get('timezone')) or as_str(existing.get('timezone')) or system_local_timezone()
    schedule = as_str(job.get('schedule'), as_str(existing.get('schedule')))
    if 'schedule' in job:
        try:
            parse_schedule(schedule)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
    next_run = existing.get('nextRunAt')
    if job.get('nextRunAt') is not None:
        next_run = job.get('nextRunAt')
    elif 'schedule' in job or 'timezone' in job or creating:
        next_run = compute_next_run_at(schedule, tz)
    merged: dict[str, object] = {
        **existing,
        **job,
        'id': jid,
        'jobType': job_type,
        'timezone': tz,
        'paused': as_bool(job.get('paused', existing.get('paused', False)), False),
        'enabled': as_bool(job.get('enabled', existing.get('enabled', True)), True),
        'updatedAt': _now(),
        'createdAt': existing.get('createdAt') or _now(),
        'runs': as_list(existing.get('runs'))[-MAX_RUNS:],
        'nextRunAt': next_run,
    }
    if creating or not as_str(merged.get('triggerToken')):
        merged['triggerToken'] = as_str(job.get('triggerToken')) or _new_trigger_token()
    merged.pop('job_type', None)
    merged.pop('type', None)
    store[jid] = _normalize_job_dict(merged)
    return dict(store[jid])


async def upsert_job_async(job: dict[str, object]) -> dict[str, object]:
    def mut(store: dict[str, dict[str, object]]) -> dict[str, object]:
        return _merge_upsert(store, job)

    return await _mutate(mut)  # type: ignore[return-value]


def upsert_job(job: dict[str, object]) -> dict[str, object]:
    return _run_coro_sync(upsert_job_async(job))  # type: ignore[return-value]


async def delete_job_async(job_id: str) -> bool:
    def mut(store: dict[str, dict[str, object]]) -> bool:
        if job_id not in store:
            return False
        del store[job_id]
        return True

    return bool(await _mutate(mut))


def delete_job(job_id: str) -> bool:
    return bool(_run_coro_sync(delete_job_async(job_id)))


async def pause_job(job_id: str, paused: bool = True) -> dict[str, object] | None:
    def mut(store: dict[str, dict[str, object]]) -> dict[str, object] | None:
        job = store.get(job_id)
        if not job:
            return None
        job['paused'] = paused
        job['updatedAt'] = _now()
        if not paused and as_bool(job.get('enabled'), True):
            job['nextRunAt'] = compute_next_run_at(
                as_str(job.get('schedule')), as_str(job.get('timezone'))
            )
        return dict(job)

    return await _mutate(mut)  # type: ignore[return-value]


async def resume_job(job_id: str) -> dict[str, object] | None:
    return await pause_job(job_id, paused=False)


async def rotate_trigger_token(job_id: str) -> dict[str, object] | None:
    def mut(store: dict[str, dict[str, object]]) -> dict[str, object] | None:
        job = store.get(job_id)
        if not job:
            return None
        job['triggerToken'] = _new_trigger_token()
        job['updatedAt'] = _now()
        return dict(job)

    return await _mutate(mut)  # type: ignore[return-value]


def append_run_record(
    job: dict[str, object],
    *,
    run_id: str,
    status: str,
    trigger: str,
    started_at: str,
    finished_at: str | None = None,
    session_id: str | None = None,
    output_snippet: str = '',
) -> None:
    runs = list(as_list(job.get('runs')))
    runs.append(
        {
            'id': run_id,
            'startedAt': started_at,
            'finishedAt': finished_at,
            'status': status,
            'sessionId': session_id,
            'outputSnippet': (output_snippet or '')[:2000],
            'trigger': trigger,
        }
    )
    job['runs'] = runs[-MAX_RUNS:]


async def append_run(
    job_id: str,
    *,
    status: str,
    trigger: str,
    started_at: str | None = None,
    finished_at: str | None = None,
    session_id: str | None = None,
    output_snippet: str = '',
) -> dict[str, object] | None:
    run_id = f'run_{uuid.uuid4().hex[:10]}'
    started = started_at or _now()

    def mut(store: dict[str, dict[str, object]]) -> dict[str, object] | None:
        job = store.get(job_id)
        if not job:
            return None
        append_run_record(
            job,
            run_id=run_id,
            status=status,
            trigger=trigger,
            started_at=started,
            finished_at=finished_at,
            session_id=session_id,
            output_snippet=output_snippet,
        )
        job['updatedAt'] = _now()
        return dict(job)

    return await _mutate(mut)  # type: ignore[return-value]


def _parse_iso(raw: object) -> datetime | None:
    s = as_str(raw)
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        return None


async def recover_stuck_running(
    *,
    boot: bool = False,
    now: datetime | None = None,
    stale_minutes: int = STALE_RUNNING_MINUTES,
) -> int:
    """Mark stuck ``running`` jobs as error; append recovery run history.

    ``boot=True`` recovers every running job (process restart). Otherwise only
    jobs older than ``stale_minutes`` are recovered.
    """
    now_utc = now or datetime.now(timezone.utc)
    cutoff = now_utc - timedelta(minutes=stale_minutes)

    def mut(store: dict[str, dict[str, object]]) -> int:
        n = 0
        for job in store.values():
            if as_str(job.get('status')) != 'running':
                continue
            started = _parse_iso(job.get('runningStartedAt') or job.get('lastRunAt'))
            if not boot and started is not None and started > cutoff:
                continue
            note = (
                'Recovered stuck running job (backend restart)'
                if boot
                else 'Recovered stuck running job (staleness timeout)'
            )
            job['status'] = 'error'
            job['lastOutput'] = note
            finished = _now()
            append_run_record(
                job,
                run_id=f'run_{uuid.uuid4().hex[:10]}',
                status='error',
                trigger='recovery',
                started_at=as_str(job.get('runningStartedAt')) or finished,
                finished_at=finished,
                session_id=as_str(job.get('sessionId')) or None,
                output_snippet=note,
            )
            job['runningStartedAt'] = None
            job['updatedAt'] = finished
            if as_bool(job.get('enabled'), True) and not as_bool(job.get('paused'), False):
                job['nextRunAt'] = compute_next_run_at(
                    as_str(job.get('schedule')), as_str(job.get('timezone'))
                )
            n += 1
        return n

    return int(await _mutate(mut))  # type: ignore[call-overload]


def due_job_ids(*, now: datetime | None = None) -> list[str]:
    """Return ids of enabled, unpaused, non-running jobs that are due."""
    now_utc = now or datetime.now(timezone.utc)
    out: list[str] = []
    for job in _load().values():
        if not as_bool(job.get('enabled'), True):
            continue
        if as_bool(job.get('paused'), False):
            continue
        if as_str(job.get('status')) == 'running':
            continue
        if is_due(
            as_str(job.get('schedule')),
            as_str(job.get('timezone')),
            as_str(job.get('nextRunAt')) or None,
            now=now_utc,
        ):
            out.append(as_str(job.get('id')))
    return out


def _run_shell(job: dict[str, object]) -> tuple[str, str, int | None]:
    import subprocess

    command = as_str(job.get('command') or job.get('task'))
    if not command:
        return 'error', 'shell job missing command', None
    completed = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=as_float(job.get('timeoutMs'), 60000.0) / 1000.0,
        cwd=as_str(job.get('cwd') or job.get('workspacePath')) or None,
    )
    out = (completed.stdout or '')[-4000:]
    status = 'idle' if completed.returncode == 0 else 'error'
    return status, out, completed.returncode


def _run_http(job: dict[str, object]) -> tuple[str, str, int | None]:
    import urllib.error
    import urllib.request

    url = as_str(job.get('url') or job.get('command'))
    if not url:
        return 'error', 'http job missing url', None
    method = as_str(job.get('method'), 'GET').upper() or 'GET'
    body = as_str(job.get('body'))
    data = body.encode('utf-8') if body and method in ('POST', 'PUT', 'PATCH') else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/json, text/plain, */*')
    if data is not None:
        req.add_header('Content-Type', as_str(job.get('contentType'), 'application/json'))
    try:
        with urllib.request.urlopen(
            req, timeout=as_float(job.get('timeoutMs'), 30000.0) / 1000.0
        ) as resp:
            raw = resp.read().decode('utf-8', errors='replace')[:4000]
            code = int(resp.status)
            status = 'idle' if 200 <= code < 400 else 'error'
            return status, raw, code
    except urllib.error.HTTPError as exc:
        return 'error', exc.read().decode('utf-8', errors='replace')[:4000], int(exc.code)
    except Exception as exc:
        return 'error', str(exc), None


def _extract_stream_text(events: list[dict[str, object]]) -> str:
    parts: list[str] = []
    for ev in events:
        t = as_str(ev.get('type') or ev.get('event'))
        if t in ('text_delta', 'content_delta', 'assistant_delta', 'delta'):
            parts.append(as_str(ev.get('text') or ev.get('delta') or ev.get('content')))
        elif t in ('final', 'message', 'assistant'):
            parts.append(as_str(ev.get('content') or ev.get('text') or ev.get('message')))
    text = ''.join(parts).strip()
    if not text and events:
        last = events[-1]
        text = as_str(last.get('content') or last.get('text') or last.get('message'))
    if text.strip() == '[SILENT]':
        return ''
    return text


async def _run_workbench_stream(job_id: str, job_snapshot: dict[str, object], *, trigger: str) -> None:
    """Consume sendWorkbenchMessageStream with short locked status writes only."""
    prompt = as_str(job_snapshot.get('prompt') or job_snapshot.get('command') or job_snapshot.get('task'))
    run_id = f'run_{uuid.uuid4().hex[:10]}'
    started_at = _now()
    session_id = ''
    events: list[dict[str, object]] = []

    if not prompt:
        await _finish_run(
            job_id,
            run_id=run_id,
            started_at=started_at,
            status='error',
            output='workbench job missing prompt',
            trigger=trigger,
            session_id=None,
        )
        return

    try:
        from app.services.workbench import workbench as wb

        sess = wb.createWorkbenchSession(
            provider=as_str(job_snapshot.get('provider') or job_snapshot.get('modelProvider')),
            agentId=as_str(job_snapshot.get('agentId'), 'build') or 'build',
            guardMode=as_str(job_snapshot.get('guardMode'), 'ask') or 'ask',
            task=f'Automation: {as_str(job_snapshot.get("name"), "job")}',
            goal=prompt[:500],
            workspacePath=as_str(job_snapshot.get('workspacePath') or job_snapshot.get('cwd')),
            sandboxMode=as_str(job_snapshot.get('sandboxMode')),
        )
        session_id = sess.id
        # Title for UI
        try:
            if hasattr(sess, 'title'):
                sess.title = f'Automation: {as_str(job_snapshot.get("name"), "job")}'
        except Exception:
            pass

        def mut_start(store: dict[str, dict[str, object]]) -> None:
            job = store.get(job_id)
            if not job:
                return
            job['status'] = 'running'
            job['runningStartedAt'] = started_at
            job['lastRunAt'] = started_at
            job['sessionId'] = session_id
            job['updatedAt'] = _now()
            append_run_record(
                job,
                run_id=run_id,
                status='running',
                trigger=trigger,
                started_at=started_at,
                session_id=session_id,
            )

        await _mutate(mut_start)

        def emit(ev: dict[str, object]) -> None:
            if isinstance(ev, dict):
                events.append(ev)

        await wb.sendWorkbenchMessageStream(
            session_id,
            prompt,
            provider=as_str(job_snapshot.get('provider') or job_snapshot.get('modelProvider')),
            agentId=as_str(job_snapshot.get('agentId'), 'build') or 'build',
            model=as_str(job_snapshot.get('model')),
            modelProvider=as_str(job_snapshot.get('modelProvider') or job_snapshot.get('provider')),
            guardMode=as_str(job_snapshot.get('guardMode'), 'ask') or 'ask',
            emit=emit,
        )
        snippet = _extract_stream_text(events)
        # Prefer last assistant message from session if stream emit sparse
        if not snippet:
            try:
                sess2 = wb.getWorkbenchSession(session_id)
                if sess2 and sess2.messages:
                    for msg in reversed(sess2.messages):
                        if msg.get('role') == 'assistant':
                            c = msg.get('content', '')
                            if isinstance(c, str):
                                snippet = c
                            break
            except Exception:
                pass
        if snippet.strip() == '[SILENT]':
            snippet = ''
        await _finish_run(
            job_id,
            run_id=run_id,
            started_at=started_at,
            status='idle',
            output=snippet[:4000],
            trigger=trigger,
            session_id=session_id,
        )
    except Exception as exc:
        logger.exception('workbench automation %s failed', job_id)
        await _finish_run(
            job_id,
            run_id=run_id,
            started_at=started_at,
            status='error',
            output=str(exc)[:4000],
            trigger=trigger,
            session_id=session_id or None,
        )


async def _finish_run(
    job_id: str,
    *,
    run_id: str,
    started_at: str,
    status: str,
    output: str,
    trigger: str,
    session_id: str | None,
    exit_code: int | None = None,
) -> None:
    finished = _now()

    def mut(store: dict[str, dict[str, object]]) -> None:
        job = store.get(job_id)
        if not job:
            return
        job['status'] = status
        job['lastOutput'] = output
        if exit_code is not None:
            job['lastExitCode'] = exit_code
        job['runningStartedAt'] = None
        job['updatedAt'] = finished
        if session_id:
            job['sessionId'] = session_id
        # Update or append run record
        runs = list(as_list(job.get('runs')))
        updated = False
        for r in runs:
            if isinstance(r, dict) and as_str(r.get('id')) == run_id:
                r['status'] = status
                r['finishedAt'] = finished
                r['outputSnippet'] = (output or '')[:2000]
                if session_id:
                    r['sessionId'] = session_id
                updated = True
                break
        if not updated:
            append_run_record(
                job,
                run_id=run_id,
                status=status,
                trigger=trigger,
                started_at=started_at,
                finished_at=finished,
                session_id=session_id,
                output_snippet=output,
            )
        else:
            job['runs'] = runs[-MAX_RUNS:]
        if as_bool(job.get('enabled'), True) and not as_bool(job.get('paused'), False):
            job['nextRunAt'] = compute_next_run_at(
                as_str(job.get('schedule')), as_str(job.get('timezone'))
            )

    await _mutate(mut)


async def run_job_async(
    job_id: str,
    approved: bool = False,
    *,
    trigger: str = 'manual',
) -> dict[str, object]:
    """Start a job. Workbench runs continue in the background after status=running."""

    def prepare(store: dict[str, dict[str, object]]) -> dict[str, object]:
        job = store.get(job_id)
        if not job:
            raise KeyError(job_id)
        if as_bool(job.get('approvalRequired'), False) and not approved:
            return {'status': 'approval_required', 'id': job_id}
        if as_str(job.get('status')) == 'running':
            return {'status': 'ok', 'id': job_id, 'job': dict(job), 'skipped': 'already_running'}
        job_type = _normalize_job_type(job.get('jobType'))
        job['jobType'] = job_type
        snap = dict(job)
        if job_type != 'workbench':
            # Workbench sets running inside the stream consumer (short lock).
            job['status'] = 'running'
            job['runningStartedAt'] = _now()
            job['lastRunAt'] = job['runningStartedAt']
            job['updatedAt'] = _now()
            snap = dict(job)
        return {'status': 'start', 'id': job_id, 'job': snap, 'jobType': job_type}

    prepared = await _mutate(prepare)  # type: ignore[assignment]
    assert isinstance(prepared, dict)
    if prepared.get('status') != 'start':
        return prepared

    job_type = as_str(prepared.get('jobType'))
    snap = as_dict(prepared.get('job'))
    run_id = f'run_{uuid.uuid4().hex[:10]}'
    started_at = as_str(snap.get('runningStartedAt')) or _now()

    if job_type == 'workbench':
        # Background consumer — return immediately so UI can poll.
        asyncio.create_task(
            _run_workbench_stream(job_id, snap, trigger=trigger),
            name=f'automation_{job_id}',
        )
        # Optimistic running marker so list polls show progress before task starts.
        def mark(store: dict[str, dict[str, object]]) -> dict[str, object] | None:
            job = store.get(job_id)
            if not job or as_str(job.get('status')) == 'running':
                return dict(job) if job else None
            job['status'] = 'running'
            job['runningStartedAt'] = _now()
            job['lastRunAt'] = job['runningStartedAt']
            job['updatedAt'] = _now()
            return dict(job)

        job = await _mutate(mark)  # type: ignore[assignment]
        return {'status': 'ok', 'id': job_id, 'job': job or get_job(job_id)}

    if job_type == 'noop':
        await _finish_run(
            job_id,
            run_id=run_id,
            started_at=started_at,
            status='idle',
            output='noop',
            trigger=trigger,
            session_id=None,
            exit_code=0,
        )
        return {'status': 'ok', 'id': job_id, 'job': get_job(job_id)}

    try:
        if job_type == 'shell':
            status, out, code = await asyncio.to_thread(_run_shell, snap)
        elif job_type == 'http':
            status, out, code = await asyncio.to_thread(_run_http, snap)
        else:
            status, out, code = 'error', f'unsupported jobType: {job_type}', None
    except Exception as exc:
        status, out, code = 'error', str(exc), None

    await _finish_run(
        job_id,
        run_id=run_id,
        started_at=started_at,
        status=status,
        output=out,
        trigger=trigger,
        session_id=None,
        exit_code=code,
    )
    return {'status': 'ok', 'id': job_id, 'job': get_job(job_id)}


def run_job(job_id: str, approved: bool = False) -> dict[str, object]:
    return _run_coro_sync(run_job_async(job_id, approved=approved))  # type: ignore[return-value]


async def tick_automations(*, now: datetime | None = None) -> list[str]:
    """Recover stale runs and fire due jobs. Returns started job ids."""
    await recover_stuck_running(boot=False, now=now or datetime.now(timezone.utc))
    started: list[str] = []
    for jid in due_job_ids(now=now):
        try:
            result = await run_job_async(jid, approved=True, trigger='schedule')
            if result.get('status') == 'ok' and not result.get('skipped'):
                started.append(jid)
        except Exception:
            logger.exception('automation tick failed for %s', jid)
    return started


async def boot_automations() -> int:
    """Boot sweep for stuck running jobs. Call once at scheduler start."""
    return await recover_stuck_running(boot=True)
