"""Goal environments API — the human door beside the model's tools.

The four ``goal_*`` tools are how the AGENT works inside an environment. This router is how the
USER looks at it and stops it: a goal list with its runs, filed outputs (with their movement
ledger), claims and marks, plus two actions — abandon a goal, close a run. There is deliberately
no create/edit here: those are the agent's own work, and a second writer would race the
optimistic lock the store enforces.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from app.lib.local_api_auth import require_local_token
from app.services.goals import records as R
from app.services.goals import store as S

router = APIRouter(prefix='/api/goals')


@router.get('')
async def list_goals(workspace: str = '', _: str = Depends(require_local_token)) -> dict[str, object]:
    """Every goal, its runs, its artifacts with their movements, and claims versus marks."""

    def _read() -> dict[str, object]:
        # A project's goals are its own. Filtering the ENVELOPE matters as much as the list: an
        # unfiltered artifacts/claims/marks call would put another project's work in this one's
        # panel, which is the exact rule the workspace column exists to keep.
        envs = S.load_envs(workspace or None)
        ids = {e.id for e in envs}
        runs: list[dict[str, object]] = []
        for env in envs:
            runs.extend(S.runs_for(env.id))
        return {
            'envs': [{
                'id': e.id, 'parentId': e.parent_id, 'title': e.title, 'goal': e.goal,
                'inputs': e.inputs, 'outputs': e.outputs,
                'bound': {'allow': list(e.bound.allow), 'deny': list(e.bound.deny),
                          'maxRounds': e.bound.max_rounds, 'contextChars': e.bound.context_chars},
                'status': e.status, 'owner': e.owner, 'version': e.version,
                'depth': e.depth, 'readOnly': not e.writable,
            } for e in envs],
            'runs': runs,
            'artifacts': [a for a in S.load_artifacts() if str(a.get('env_id') or '') in ids],
            'claims': [c for c in S.load_claims() if str(c.get('env_id') or '') in ids],
            'marks': [m for m in S.load_marks() if str(m.get('env_id') or '') in ids],
        }

    return await asyncio.to_thread(_read)


@router.post('/{env_id}/abandon')
async def abandon_goal(env_id: str, _: str = Depends(require_local_token)) -> dict[str, object]:
    """Stop a goal from the UI. Filed outputs and marks stay; nothing the user wrote is deleted."""
    try:
        env, _notes = await asyncio.to_thread(
            S.edit_env, env_id, {'status': 'abandoned', 'reason': 'stopped from the app'})
    except R.GoalRefusal as exc:
        raise HTTPException(status_code=400, detail=' · '.join(exc.reasons)) from exc
    return {'id': env.id, 'status': env.status, 'version': env.version}


@router.post('/runs/{run_id}/close')
async def close_run(run_id: str, _: str = Depends(require_local_token)) -> dict[str, object]:
    """Close a run the model left open. Only the run ends here — the goal keeps its state."""
    try:
        run = await asyncio.to_thread(S.move_run, run_id, 'done', 'closed from the app')
    except R.GoalRefusal as exc:
        raise HTTPException(status_code=400, detail=' · '.join(exc.reasons)) from exc
    return {'id': run.id, 'status': run.status, 'round': run.round}
