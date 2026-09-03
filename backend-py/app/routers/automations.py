"""Automations API — durable jobs in data/automations.json.

  GET    /api/automations
  POST   /api/automations                 — create/upsert (mints triggerToken on create)
  PATCH  /api/automations/{id}            — pause/resume/enable
  POST   /api/automations/run             — run now
  POST   /api/automations/{id}/trigger    — webhook; Bearer triggerToken
  POST   /api/automations/{id}/rotate-token
  DELETE /api/automations/{id}

Trigger tokens are opaque secrets stored plaintext in local automations.json
(accepted risk for a desktop tool). No rate-limit or replay protection this
pass — rotate-token is the user-facing control if a token leaks.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request

from app.json_narrowing import as_str
from app.models.camel_base import CamelModel
from app.services import automations_store as store
from app.services.automations_schedule import system_local_timezone

router = APIRouter(prefix='/api/automations')


class RunBody(CamelModel):
    id: str
    approved: bool = False


class UpsertBody(CamelModel):
    id: str | None = None
    name: str = ''
    schedule: str = ''
    job_type: str = 'workbench'
    prompt: str = ''
    command: str = ''
    task: str = ''
    cwd: str = ''
    workspace_path: str = ''
    timezone: str = ''
    model: str = ''
    model_provider: str = ''
    provider: str = ''
    agent_id: str = ''
    guard_mode: str = 'ask'
    sandbox_mode: str = ''
    enabled: bool = True
    paused: bool = False
    approval_required: bool = False
    timeout_ms: int = 60000
    url: str = ''
    method: str = 'GET'
    body: str = ''
    max_runs: int = 0
    # Part 19 Phase B (routines): delivery + memory knobs. The runner path
    # already honors these (automations_store._run_workbench_stream +
    # automation_memory) — surfaced here so the RoutinesPane (and any API
    # client) can create routine jobs that land their output in the Bot's
    # canonical chat. Empty deliver = a plain automation (no chat routing).
    deliver: str = ''
    respond: bool = True
    continuity: bool = False


class PatchBody(CamelModel):
    paused: bool | None = None
    enabled: bool | None = None
    name: str | None = None
    schedule: str | None = None
    prompt: str | None = None
    timezone: str | None = None
    workspace_path: str | None = None
    model: str | None = None
    model_provider: str | None = None
    agent_id: str | None = None
    max_runs: int | None = None
    # Part 19 Phase B: routine fields are patchable (pause the response turn,
    # toggle the notepad continuity, repoint delivery).
    deliver: str | None = None
    respond: bool | None = None
    continuity: bool | None = None


def _wire(job: dict[str, object], *, include_token: bool = False) -> dict[str, object]:
    job_type = as_str(job.get('jobType') or job.get('type'), 'workbench')
    out: dict[str, object] = {
        'id': job.get('id'),
        'name': job.get('name'),
        'jobType': job_type,
        'type': job_type,  # legacy alias
        'schedule': job.get('schedule'),
        'timezone': job.get('timezone') or system_local_timezone(),
        'prompt': job.get('prompt'),
        'command': job.get('command') or job.get('task'),
        'task': job.get('task') or job.get('command') or job.get('prompt'),
        'cwd': job.get('cwd') or job.get('workspacePath'),
        'workspacePath': job.get('workspacePath') or job.get('cwd'),
        'model': job.get('model'),
        'modelProvider': job.get('modelProvider') or job.get('provider'),
        'provider': job.get('provider') or job.get('modelProvider'),
        'agentId': job.get('agentId'),
        'guardMode': job.get('guardMode'),
        'sandboxMode': job.get('sandboxMode'),
        'enabled': job.get('enabled', True),
        'paused': job.get('paused', False),
        'approved': not job.get('approvalRequired'),
        'approvalRequired': job.get('approvalRequired', False),
        'timeoutMs': job.get('timeoutMs') or job.get('timeout_ms'),
        'status': job.get('status'),
        'lastRunAt': job.get('lastRunAt'),
        'nextRunAt': job.get('nextRunAt'),
        'maxRuns': job.get('maxRuns') or 0,
        'limitReached': job.get('limitReached', False),
        'lastOutput': job.get('lastOutput'),
        # M-11: derived from the runs ledger by _finish_run (legacy alias for
        # the old lastResult/lastError fields the scheduler used to own).
        'lastResult': job.get('lastResult'),
        'lastError': job.get('lastError'),
        'sessionId': job.get('sessionId'),
        'runs': job.get('runs') or [],
        'createdAt': job.get('createdAt'),
        # Part 19 Phase B routine fields (echo for the RoutinesPane).
        'deliver': job.get('deliver', ''),
        'respond': bool(job.get('respond', True)),
        'continuity': bool(job.get('continuity', False)),
        'updatedAt': job.get('updatedAt'),
        'url': job.get('url'),
        'method': job.get('method'),
    }
    if include_token:
        out['triggerToken'] = job.get('triggerToken')
        out['triggerUrlHint'] = f'/api/automations/{job.get("id")}/trigger'
    return out


@router.get('')
async def list_automations():
    return {'jobs': [_wire(j) for j in store.list_jobs()]}


@router.post('')
async def upsert_automation(body: UpsertBody):
    creating = not (body.id and store.get_job(body.id))
    payload: dict[str, object] = {
        'id': body.id or '',
        'name': body.name or body.prompt or body.command or body.task or 'Automation',
        'schedule': body.schedule,
        'jobType': body.job_type or 'workbench',
        'prompt': body.prompt or body.task or body.command,
        'command': body.command or body.task,
        'task': body.task or body.command or body.prompt,
        'cwd': body.cwd or body.workspace_path,
        'workspacePath': body.workspace_path or body.cwd,
        'timezone': body.timezone or system_local_timezone(),
        'model': body.model,
        'modelProvider': body.model_provider or body.provider,
        'provider': body.provider or body.model_provider,
        'agentId': body.agent_id,
        'guardMode': body.guard_mode,
        'sandboxMode': body.sandbox_mode,
        'enabled': body.enabled,
        'paused': body.paused,
        'approvalRequired': body.approval_required,
        'timeoutMs': body.timeout_ms,
        'url': body.url,
        'method': body.method,
        'body': body.body,
        'maxRuns': body.max_runs or 0,
        # Part 19 Phase B routine fields (pass through to the runner).
        'deliver': body.deliver,
        'respond': body.respond,
        'continuity': body.continuity,
    }
    try:
        job = await store.upsert_job_async(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _wire(job, include_token=creating)


@router.patch('/{job_id}')
async def patch_automation(job_id: str, body: PatchBody):
    if not store.get_job(job_id):
        raise HTTPException(status_code=404, detail='Automation not found')
    updates: dict[str, object] = {'id': job_id}
    if body.paused is not None:
        updates['paused'] = body.paused
    if body.enabled is not None:
        updates['enabled'] = body.enabled
    if body.name is not None:
        updates['name'] = body.name
    if body.schedule is not None:
        updates['schedule'] = body.schedule
    if body.prompt is not None:
        updates['prompt'] = body.prompt
    if body.timezone is not None:
        updates['timezone'] = body.timezone
    if body.workspace_path is not None:
        updates['workspacePath'] = body.workspace_path
    if body.model is not None:
        updates['model'] = body.model
    if body.model_provider is not None:
        updates['modelProvider'] = body.model_provider
    if body.agent_id is not None:
        updates['agentId'] = body.agent_id
    if body.max_runs is not None:
        updates['maxRuns'] = body.max_runs
    # Part 19 Phase B: routine field patches.
    if body.deliver is not None:
        updates['deliver'] = body.deliver
    if body.respond is not None:
        updates['respond'] = body.respond
    if body.continuity is not None:
        updates['continuity'] = body.continuity
    if body.paused is not None and len(updates) == 2:
        job = await store.pause_job(job_id, paused=body.paused)
        if not job:
            raise HTTPException(status_code=404, detail='Automation not found')
        return _wire(job)
    try:
        job = await store.upsert_job_async(updates)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _wire(job)


@router.post('/run')
async def run_automation(body: RunBody):
    try:
        result = await store.run_job_async(body.id, approved=body.approved, trigger='manual')
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


@router.post('/{job_id}/trigger')
async def trigger_automation(
    job_id: str,
    request: Request,
    authorization: str | None = Header(default=None),
):
    """Webhook trigger. Requires ``Authorization: Bearer {triggerToken}``."""
    job = store.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Automation not found')
    token = ''
    if authorization and authorization.lower().startswith('bearer '):
        token = authorization[7:].strip()
    if not token:
        # Also accept ?token= for local curl convenience
        token = as_str(request.query_params.get('token'))
    expected = as_str(job.get('triggerToken'))
    if not expected or token != expected:
        raise HTTPException(status_code=401, detail='Invalid trigger token')
    if as_bool_paused(job):
        raise HTTPException(status_code=409, detail='Automation is paused')
    result = await store.run_job_async(job_id, approved=True, trigger='webhook')
    job_out = result.get('job')
    return {
        'status': result.get('status'),
        'id': job_id,
        'job': _wire(job_out) if isinstance(job_out, dict) else None,
    }


def as_bool_paused(job: dict[str, object]) -> bool:
    from app.json_narrowing import as_bool

    return as_bool(job.get('paused'), False)


@router.post('/{job_id}/rotate-token')
async def rotate_token(job_id: str):
    job = await store.rotate_trigger_token(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Automation not found')
    return _wire(job, include_token=True)


@router.post('/{job_id}/cancel')
async def cancel_automation(job_id: str):
    """Cancel a running automation (background workbench task + status)."""
    job = await store.cancel_job_async(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='Automation not found')
    return _wire(job)


@router.get('/incidents')
async def list_incidents():
    """M-11: open incidents across all jobs (state != 'closed')."""
    from app.services import automation_memory

    raw = automation_memory.open_incidents()
    return {
        'incidents': [
            {
                'jobId': r.get('job_id'),
                'signature': r.get('signature'),
                'state': r.get('state'),
                'count': r.get('count', 0),
                'firstSeenAt': r.get('first_seen_at'),
                'lastSeenAt': r.get('last_seen_at'),
            }
            for r in raw
        ]
    }


@router.get('/{job_id}/runs')
async def list_runs(job_id: str, limit: int = 10):
    """M-11: the run ledger for one job (newest first)."""
    from app.services import automation_memory

    rows = automation_memory.runs_for_job(job_id, limit=limit)
    return {
        'runs': [
            {
                'id': r.get('id'),
                'jobId': r.get('job_id'),
                'status': r.get('status'),
                'trigger': r.get('trigger'),
                'startedAt': r.get('started_at'),
                'finishedAt': r.get('finished_at'),
                'errorSignature': r.get('error_signature'),
                'sessionId': r.get('session_id'),
                'outputDigest': r.get('output_digest'),
            }
            for r in rows
        ]
    }


@router.delete('/{job_id}')
async def delete_automation(job_id: str):
    if not await store.delete_job_async(job_id):
        raise HTTPException(status_code=404, detail='Automation not found')
    return {'deleted': True}
