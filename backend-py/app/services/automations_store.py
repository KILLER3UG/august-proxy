"""Durable automations store — atomic JSON under data/automations.json."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_bool, as_dict, as_list, as_str
from app.lib.paths import dataPath

_FILE = 'automations.json'
_jobs: dict[str, dict[str, object]] | None = None
_jobs_path_key: str | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path():
    return dataPath(_FILE)


def reset_store() -> None:
    """Test helper — drop process cache so next load re-reads disk."""
    global _jobs, _jobs_path_key
    _jobs = None
    _jobs_path_key = None


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
    merged = {
        **existing,
        **job,
        'id': jid,
        'updatedAt': _now(),
        'createdAt': existing.get('createdAt') or _now(),
        'enabled': as_bool(job.get('enabled', existing.get('enabled', True)), True),
    }
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


def run_job(job_id: str, approved: bool = False) -> dict[str, object]:
    job = get_job(job_id)
    if not job:
        raise KeyError(job_id)
    if as_bool(job.get('approvalRequired'), False) and not approved:
        return {'status': 'approval_required', 'id': job_id}
    job['status'] = 'running'
    job['lastRunAt'] = _now()
    job['updatedAt'] = _now()
    # Shell/command jobs: best-effort execute if command present
    command = as_str(job.get('command') or job.get('task'))
    if command:
        import subprocess

        try:
            # Sync subprocess — automations are operator-triggered, not hot path
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
        except Exception as exc:
            job['status'] = 'error'
            job['lastOutput'] = str(exc)
    else:
        job['status'] = 'idle'
    store = _load()
    store[job_id] = job
    _save()
    return {'status': 'ok', 'id': job_id, 'job': job}
