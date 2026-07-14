"""Automations API — durable jobs in data/automations.json.

  GET    /api/automations
  POST   /api/automations          — create/upsert
  POST   /api/automations/run
  DELETE /api/automations/{id}
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services import automations_store as store

router = APIRouter(prefix='/api/automations')


class RunBody(CamelModel):
    id: str
    approved: bool = False


class UpsertBody(CamelModel):
    id: str | None = None
    name: str = ''
    schedule: str = ''
    command: str = ''
    task: str = ''
    cwd: str = ''
    enabled: bool = True
    approval_required: bool = False
    timeout_ms: int = 60000


def _wire(job: dict[str, object]) -> dict[str, object]:
    return {
        'id': job.get('id'),
        'name': job.get('name'),
        'type': job.get('type') or 'shell',
        'schedule': job.get('schedule'),
        'command': job.get('command') or job.get('task'),
        'task': job.get('task') or job.get('command'),
        'cwd': job.get('cwd'),
        'enabled': job.get('enabled', True),
        'approved': not job.get('approvalRequired'),
        'approvalRequired': job.get('approvalRequired', False),
        'timeoutMs': job.get('timeoutMs') or job.get('timeout_ms'),
        'status': job.get('status'),
        'lastRunAt': job.get('lastRunAt'),
        'createdAt': job.get('createdAt'),
        'updatedAt': job.get('updatedAt'),
    }


@router.get('')
async def list_automations():
    return {'jobs': [_wire(j) for j in store.list_jobs()]}


@router.post('')
async def upsert_automation(body: UpsertBody):
    job = store.upsert_job(
        {
            'id': body.id or '',
            'name': body.name or body.command or body.task or 'Automation',
            'schedule': body.schedule,
            'command': body.command or body.task,
            'task': body.task or body.command,
            'cwd': body.cwd,
            'enabled': body.enabled,
            'approvalRequired': body.approval_required,
            'timeoutMs': body.timeout_ms,
            'type': 'shell',
        }
    )
    return _wire(job)


@router.post('/run')
async def run_automation(body: RunBody):
    try:
        result = store.run_job(body.id, approved=body.approved)
    except KeyError:
        raise HTTPException(status_code=404, detail='Automation not found') from None
    if result.get('status') == 'approval_required':
        return result
    job = result.get('job')
    return {
        'status': result.get('status'),
        'id': body.id,
        'job': _wire(job) if isinstance(job, dict) else None,
    }


@router.delete('/{job_id}')
async def delete_automation(jobId: str):
    if not store.delete_job(jobId):
        raise HTTPException(status_code=404, detail='Automation not found')
    return {'deleted': True}
