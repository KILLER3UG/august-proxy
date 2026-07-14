"""Cron job API routes.

Port of backend/services/scheduler/index.js + missing/cron-tools.js.
Manages scheduled/recurring job execution.

Request body ``CronJobCreate`` inherits :class:`CamelModel` so internals are
snake_case while JSON from the frontend stays camelCase.
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel

router = APIRouter(prefix='/api/cron')
_jobs: dict[str, dict[str, object]] = {}


class CronJobCreate(CamelModel):
    """Cron job create body. Internals are snake_case; JSON stays camelCase."""

    name: str
    schedule: str
    command: str
    enabled: bool = True


@router.get('')
async def listCronJobs() -> dict[str, object]:
    """List all cron jobs."""
    return {'jobs': list(_jobs.values())}


@router.post('')
async def createCronJob(body: CronJobCreate) -> dict[str, object]:
    """Create a new cron job."""
    import uuid

    jobId = f'cron_{uuid.uuid4().hex[:8]}'
    job = {
        'id': jobId,
        'name': body.name,
        'schedule': body.schedule,
        'command': body.command,
        'enabled': body.enabled,
        'status': 'idle',
        'lastRun': None,
        'nextRun': None,
    }
    _jobs[jobId] = job
    return job


@router.get('/{job_id}')
async def getCronJob(jobId: str) -> dict[str, object]:
    """Get a cron job by ID."""
    job = _jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')
    return job


@router.delete('/{job_id}')
async def deleteCronJob(jobId: str) -> dict[str, object]:
    """Delete a cron job."""
    if jobId not in _jobs:
        raise HTTPException(status_code=404, detail='Job not found')
    del _jobs[jobId]
    return {'status': 'ok'}


@router.post('/{job_id}/toggle')
async def toggleCronJob(jobId: str) -> dict[str, object]:
    """Enable or disable a cron job."""
    job = _jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')
    job['enabled'] = not job['enabled']
    return {'enabled': job['enabled']}


@router.post('/{job_id}/run')
async def runCronJob(jobId: str) -> dict[str, object]:
    """Trigger immediate execution of a cron job."""
    job = _jobs.get(jobId)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')
    job['status'] = 'running'
    return {'status': 'running', 'message': 'Cron execution requires scheduler implementation'}
