"""Durable automations store — atomic JSON under data/automations.json.

Job types (long-term enum):
  * shell     — run a shell command (approval may be required)
  * workbench — enqueue a workbench prompt against a session
  * http      — POST/GET a URL
  * noop      — durable schedule placeholder (no side effect)
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Final

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_bool, as_dict, as_list, as_str
from app.lib.paths import dataPath

_FILE = 'automations.json'
_jobs: dict[str, dict[str, object]] | None = None
_jobs_path_key: str | None = None

JOB_TYPES: Final[frozenset[str]] = frozenset({'shell', 'workbench', 'http', 'noop'})
DEFAULT_JOB_TYPE = 'shell'


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
        # Legacy jobs without type: treat as shell when command present else noop
        return DEFAULT_JOB_TYPE
    return t


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
                    if 'jobType' not in d and 'job_type' not in d:
                        d['jobType'] = (
                            'shell'
                            if as_str(d.get('command') or d.get('task'))
                            else 'noop'
                        )
                    else:
                        d['jobType'] = _normalize_job_type(d.get('jobType') or d.get('job_type'))
                    _jobs[jid] = d
        except Exception:
            _jobs = {}
    return _jobs


def _save() -> None:
    jobs = list(_load().values())
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, {'jobs': jobs, 'updatedAt': _now()}, indent=2)


def list_jobs() -> list[dict[str, object]]:
    return list(_load().values())


def get_job(job_id: str) -> dict[str, object] | None:
    return _load().get(job_id)


def upsert_job(job: dict[str, object]) -> dict[str, object]:
    store = _load()
    jid = as_str(job.get('id')) or f'auto_{uuid.uuid4().hex[:10]}'
    existing = store.get(jid) or {}
    raw_type = job.get('jobType') if 'jobType' in job else job.get('job_type')
    if raw_type is not None and as_str(raw_type).strip():
        candidate = as_str(raw_type).strip().lower()
        if candidate not in JOB_TYPES:
            raise ValueError(f'unknown jobType {candidate!r}; expected one of {sorted(JOB_TYPES)}')
        job_type = candidate
    else:
        job_type = _normalize_job_type(
            existing.get('jobType') or existing.get('job_type')
        )
    merged = {
        **existing,
        **job,
        'id': jid,
        'jobType': job_type,
        'updatedAt': _now(),
        'createdAt': existing.get('createdAt') or _now(),
        'enabled': as_bool(job.get('enabled', existing.get('enabled', True)), True),
    }
    # Drop snake alias after normalize
    merged.pop('job_type', None)
    store[jid] = merged
    _save()
    return merged


def delete_job(job_id: str) -> bool:
    store = _load()
    if job_id not in store:
        return False
    del store[job_id]
    _save()
    return True


def _run_shell(job: dict[str, object]) -> None:
    import subprocess

    command = as_str(job.get('command') or job.get('task'))
    if not command:
        job['status'] = 'error'
        job['lastOutput'] = 'shell job missing command'
        return
    completed = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=float(job.get('timeoutMs') or 60000) / 1000.0,
        cwd=as_str(job.get('cwd')) or None,
    )
    job['lastExitCode'] = completed.returncode
    job['lastOutput'] = (completed.stdout or '')[-4000:]
    job['status'] = 'idle' if completed.returncode == 0 else 'error'


def _run_http(job: dict[str, object]) -> None:
    import urllib.error
    import urllib.request

    url = as_str(job.get('url') or job.get('command'))
    if not url:
        job['status'] = 'error'
        job['lastOutput'] = 'http job missing url'
        return
    method = as_str(job.get('method'), 'GET').upper() or 'GET'
    body = as_str(job.get('body'))
    data = body.encode('utf-8') if body and method in ('POST', 'PUT', 'PATCH') else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Accept', 'application/json, text/plain, */*')
    if data is not None:
        req.add_header('Content-Type', as_str(job.get('contentType'), 'application/json'))
    try:
        with urllib.request.urlopen(req, timeout=float(job.get('timeoutMs') or 30000) / 1000.0) as resp:
            raw = resp.read().decode('utf-8', errors='replace')[:4000]
            job['lastExitCode'] = int(resp.status)
            job['lastOutput'] = raw
            job['status'] = 'idle' if 200 <= int(resp.status) < 400 else 'error'
    except urllib.error.HTTPError as exc:
        job['lastExitCode'] = int(exc.code)
        job['lastOutput'] = exc.read().decode('utf-8', errors='replace')[:4000]
        job['status'] = 'error'
    except Exception as exc:
        job['status'] = 'error'
        job['lastOutput'] = str(exc)


def _run_workbench(job: dict[str, object]) -> None:
    """Enqueue a prompt onto a workbench session (sync create/send best-effort)."""
    prompt = as_str(job.get('prompt') or job.get('command') or job.get('task'))
    session_id = as_str(job.get('sessionId') or job.get('session_id'))
    if not prompt:
        job['status'] = 'error'
        job['lastOutput'] = 'workbench job missing prompt'
        return
    try:
        from app.services.workbench import workbench as wb

        if session_id:
            sess = wb.getWorkbenchSession(session_id)
            if not sess:
                job['status'] = 'error'
                job['lastOutput'] = f'workbench session not found: {session_id}'
                return
        else:
            sess = wb.createWorkbenchSession(
                provider=as_str(job.get('provider')),
                agentId=as_str(job.get('agentId'), 'build') or 'build',
                guardMode='ask',
            )
            session_id = sess.id
            job['sessionId'] = session_id
        # Non-streaming one-shot when available; otherwise mark enqueued.
        if hasattr(wb, 'sendWorkbenchMessage'):
            out = wb.sendWorkbenchMessage(session_id, prompt)  # type: ignore[attr-defined]
            job['lastOutput'] = str(out)[:4000]
        else:
            job['lastOutput'] = f'queued on session {session_id}: {prompt[:200]}'
        job['status'] = 'idle'
        job['lastExitCode'] = 0
    except Exception as exc:
        job['status'] = 'error'
        job['lastOutput'] = str(exc)


def run_job(job_id: str, approved: bool = False) -> dict[str, object]:
    job = get_job(job_id)
    if not job:
        raise KeyError(job_id)
    if as_bool(job.get('approvalRequired'), False) and not approved:
        return {'status': 'approval_required', 'id': job_id}
    job['status'] = 'running'
    job['lastRunAt'] = _now()
    job['updatedAt'] = _now()
    job_type = _normalize_job_type(job.get('jobType') or job.get('job_type'))
    job['jobType'] = job_type
    try:
        if job_type == 'shell':
            _run_shell(job)
        elif job_type == 'http':
            _run_http(job)
        elif job_type == 'workbench':
            _run_workbench(job)
        elif job_type == 'noop':
            job['status'] = 'idle'
            job['lastOutput'] = 'noop'
            job['lastExitCode'] = 0
        else:
            job['status'] = 'error'
            job['lastOutput'] = f'unsupported jobType: {job_type}'
    except Exception as exc:
        job['status'] = 'error'
        job['lastOutput'] = str(exc)
    store = _load()
    store[job_id] = job
    _save()
    return {'status': 'ok', 'id': job_id, 'job': job}
