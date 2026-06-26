"""Cron job API routes.

Port of backend/services/scheduler/index.js + missing/cron-tools.js.
Manages scheduled/recurring job execution.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from app.lib.camel_model import CamelModel

router = APIRouter(prefix="/api/cron")

# In-memory cron job store
_jobs: dict[str, dict[str, Any]] = {}


class CronJobCreate(CamelModel):
    name: str
    schedule: str  # cron expression
    command: str
    enabled: bool = True


@router.get("")
async def list_cron_jobs():
    """List all cron jobs."""
    return {"jobs": list(_jobs.values())}


@router.post("")
async def create_cron_job(body: CronJobCreate):
    """Create a new cron job."""
    import uuid
    job_id = f"cron_{uuid.uuid4().hex[:8]}"
    job = {
        "id": job_id,
        "name": body.name,
        "schedule": body.schedule,
        "command": body.command,
        "enabled": body.enabled,
        "status": "idle",
        "lastRun": None,
        "nextRun": None,
    }
    _jobs[job_id] = job
    return job


@router.get("/{job_id}")
async def get_cron_job(job_id: str):
    """Get a cron job by ID."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.delete("/{job_id}")
async def delete_cron_job(job_id: str):
    """Delete a cron job."""
    if job_id not in _jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    del _jobs[job_id]
    return {"status": "ok"}


@router.post("/{job_id}/toggle")
async def toggle_cron_job(job_id: str):
    """Enable or disable a cron job."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job["enabled"] = not job["enabled"]
    return {"enabled": job["enabled"]}


@router.post("/{job_id}/run")
async def run_cron_job(job_id: str):
    """Trigger immediate execution of a cron job."""
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job["status"] = "running"
    # In a full implementation, this would spawn an async task
    return {"status": "running", "message": "Cron execution requires scheduler implementation"}
