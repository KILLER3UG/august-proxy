"""Curator API routes — usage telemetry, pin, archive, restore, and manual run."""

from __future__ import annotations
from fastapi import APIRouter, HTTPException, Request
from app.services.skills.curator import SkillCurator

router = APIRouter(prefix='/api/curator')


def _curator(request: Request) -> SkillCurator:
    from app.services.runtime_services import get_curator

    return get_curator(request.app)


@router.get('/usage')
async def listUsage(request: Request):
    """List usage telemetry for all tracked skills."""
    c = _curator(request)
    return {'usage': c.list_usage()}


@router.post('/pin/{name}')
async def pinSkill(name: str, request: Request):
    c = _curator(request)
    if not c.pin(name):
        raise HTTPException(status_code=400, detail=f"Cannot pin '{name}': not an agent-authored skill")
    return {'status': 'pinned', 'name': name}


@router.post('/unpin/{name}')
async def unpinSkill(name: str, request: Request):
    c = _curator(request)
    if c.unpin(name):
        return {'status': 'unpinned', 'name': name}
    raise HTTPException(status_code=404, detail=f"Skill '{name}' not tracked")


@router.post('/archive/{name}')
async def archiveSkill(name: str, request: Request):
    c = _curator(request)
    if not c.archive(name):
        raise HTTPException(status_code=400, detail=f"Cannot archive '{name}'")
    return {'status': 'archived', 'name': name}


@router.post('/restore/{name}')
async def restoreSkill(name: str, request: Request):
    c = _curator(request)
    if not c.restore(name):
        raise HTTPException(status_code=400, detail=f"Cannot restore '{name}'")
    return {'status': 'restored', 'name': name}


@router.post('/run')
async def runCuration(request: Request, dryRun: bool = False):
    """Run a curation pass now (all transitions, or dry-run)."""
    c = _curator(request)
    report = c.run_curation(dryRun=dryRun)
    return {'report': report}
