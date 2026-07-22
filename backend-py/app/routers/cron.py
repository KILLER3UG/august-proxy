"""Cron job API routes — durable jobs via ``scheduler`` (scheduled-jobs.json).

Request body ``CronJobCreate`` inherits :class:`CamelModel` so internals are
snake_case while JSON from the frontend stays camelCase.
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services import scheduler

router = APIRouter(prefix='/api/cron')


class CronJobCreate(CamelModel):
    """Cron job create body. Internals are snake_case; JSON stays camelCase."""

    name: str
    schedule: str
    command: str
    enabled: bool = True


def _ensure() -> None:
    scheduler._loadJobs()


def _get(job_id: str) -> dict[str, object] | None:
    _ensure()
    for job in scheduler.listJobs():
        if job.get('id') == job_id:
            return job
    return None


@router.get('')
async def listCronJobs() -> dict[str, object]:
    """List all cron jobs."""
    _ensure()
    return {'jobs': scheduler.listJobs()}


@router.post('')
async def createCronJob(body: CronJobCreate) -> dict[str, object]:
    """Create a new cron job."""
    _ensure()
    return scheduler.createJob(body.name, body.schedule, body.command, body.enabled)


@router.get('/{job_id}')
async def getCronJob(job_id: str) -> dict[str, object]:
    """Get a cron job by ID."""
    job = _get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')
    return job


@router.delete('/{job_id}')
async def deleteCronJob(job_id: str) -> dict[str, object]:
    """Delete a cron job."""
    _ensure()
    if not scheduler.deleteJob(job_id):
        raise HTTPException(status_code=404, detail='Job not found')
    return {'status': 'ok'}


@router.post('/{job_id}/toggle')
async def toggleCronJob(job_id: str) -> dict[str, object]:
    """Enable or disable a cron job."""
    job = _get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')
    updated = scheduler.updateJob(job_id, {'enabled': not bool(job.get('enabled'))})
    if not updated:
        raise HTTPException(status_code=404, detail='Job not found')
    return {'enabled': bool(updated.get('enabled'))}


@router.post('/{job_id}/run')
async def runCronJob(job_id: str) -> dict[str, object]:
    """Trigger immediate execution of a cron job."""
    job = _get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Job not found')
    result = await scheduler.runJobNow(job_id)
    if result.get('error') == 'Job not found':
        raise HTTPException(status_code=404, detail='Job not found')
    return result
