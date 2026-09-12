"""Recurring-task daemon API (B7).

Endpoints:
  GET    /api/tasks/recurring          — list active tasks
  POST   /api/tasks/recurring          — add {trigger, message}
  DELETE /api/tasks/recurring/{id}     — remove a task
  PATCH  /api/tasks/recurring/{id}     — pause/resume {active: bool}
  GET    /api/tasks/recurring/{id}/runs— per-fire history (newest first, ≤20)
  POST   /api/tasks/recurring/check    — evaluate now (manual trigger)
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.json_narrowing import as_str

router = APIRouter(prefix='/api/tasks/recurring')


@router.get('')
async def listRecurringTasks():
    """List recurring tasks (active + inactive when ?all=1)."""
    from app.services.recurring_tasks import list_tasks

    return {'tasks': list_tasks(active_only=False)}


@router.post('')
async def addRecurringTask(body: dict):
    """Add a recurring task.

    Body: ``{ "trigger": "every 2 hours" | "when I open the repo", "message": "…" }``
    """
    from app.services.recurring_tasks import add_task

    task_id = add_task(
        as_str(body.get('trigger'), ''),
        as_str(body.get('message'), ''),
        as_str(body.get('model'), ''),
    )
    if task_id is None:
        raise HTTPException(status_code=400, detail='trigger and message are required')
    return {'id': task_id}


@router.delete('/{task_id}')
async def deleteRecurringTask(task_id: int):
    """Remove a recurring task."""
    from app.services.recurring_tasks import delete_task

    if not delete_task(task_id):
        raise HTTPException(status_code=404, detail='Task not found')
    return {'deleted': True}


@router.patch('/{task_id}')
async def patchRecurringTask(task_id: int, body: dict):
    """Pause/resume: ``{ "active": false }`` stops firing without deleting."""
    from app.services.recurring_tasks import set_active

    if not isinstance(body, dict) or 'active' not in body:
        raise HTTPException(status_code=400, detail="body needs {active: bool}")
    if not set_active(task_id, bool(body.get('active'))):
        raise HTTPException(status_code=404, detail='Task not found')
    return {'id': task_id, 'active': bool(body.get('active'))}


@router.get('/{task_id}/runs')
async def recurringTaskRuns(task_id: int):
    """Per-fire history for one task (newest first, capped at 20)."""
    from app.services.recurring_tasks import get_runs

    return {'runs': get_runs(task_id)}


@router.post('/check')
async def checkRecurringTasks(body: dict = {}):
    """Evaluate tasks now (manual trigger; normally runs per chat turn)."""
    from app.services.recurring_tasks import check_and_fire

    fired = check_and_fire(
        as_str(body.get('sessionId'), ''),
        as_str(body.get('workspacePath'), ''),
    )
    return {'fired': fired}
