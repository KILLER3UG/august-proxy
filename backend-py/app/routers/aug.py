"""AUG routes — AUG.md management + plan/todo artifact persistence.

Endpoints:
  GET  /api/aug/context                 → current AUG.md { exists, body, frontmatter, path }
  POST /api/aug/init                    → LLM draft { draft, existing, analysis, mode }
  PUT  /api/aug/content                 → write AUG.md { path, bytes }
  DELETE /api/aug/content               → remove AUG.md { path, removed }
  GET  /api/aug/plans                   → list .aug artifacts { artifacts: [...] }
  DELETE /api/aug/plans/{kind}/{slug}   → manual delete { removed }
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Body

from app.services import augDirectiveService
from app.services import augArtifactService

router = APIRouter(prefix='/api/aug')


@router.get('/context')
async def getAugContext(workspacePath: str = Query('', description='Workspace path (falls back to project root)')):
    """Return the current AUG.md for a workspace."""
    loaded = augDirectiveService.load(workspacePath or None)
    if not loaded:
        return {'exists': False, 'body': '', 'frontmatter': {}, 'path': ''}
    return {
        'exists': True,
        'body': loaded['body'],
        'frontmatter': loaded['frontmatter'],
        'path': loaded['path'],
    }


@router.post('/init')
async def initAug(payload: dict = Body(...)):
    """Analyze the workspace and generate (or refine) an AUG.md draft.

    Body: { mode?: 'create' | 'refine', workspacePath?: str, model?: str }
    Returns a draft for review — does NOT write to disk.
    """
    workspacePath = payload.get('workspacePath') or ''
    mode = payload.get('mode') or 'create'
    model = payload.get('model') or ''
    if mode == 'refine' and not augDirectiveService.exists(workspacePath or None):
        mode = 'create'
    existing = None
    if mode == 'refine':
        loaded = augDirectiveService.load(workspacePath or None)
        existing = loaded['body'] if loaded else None
    try:
        result = await augDirectiveService.generate(
            workspacePath, mode=mode, existing=existing, model=model
        )
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=f'AUG.md generation failed: {exc}')
    return result


@router.put('/content')
async def putAugContent(payload: dict = Body(...)):
    """Persist an AUG.md draft. Body: { content, workspacePath?, sessionId? }."""
    content = payload.get('content')
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(status_code=400, detail='content is required')
    workspacePath = payload.get('workspacePath') or None
    try:
        result = augDirectiveService.write(workspacePath, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    sessionId = payload.get('sessionId')
    if sessionId:
        try:
            from app.services.workbench.promptCache import getCache
            getCache().invalidate(sessionId)
        except Exception:
            pass
    return result


@router.delete('/content')
async def deleteAugContent(workspacePath: str = Query('')):
    """Remove the workspace AUG.md if present."""
    return augDirectiveService.delete(workspacePath or None)


@router.get('/plans')
async def listAugPlans(workspacePath: str = Query('', description='Workspace path (falls back to project root)')):
    """List `.aug` plan/todo artifacts for manual cleanup."""
    artifacts = augArtifactService.listArtifacts(workspacePath or None)
    return {'artifacts': artifacts}


@router.delete('/plans/{kind}/{slug}')
async def deleteAugPlan(kind: str, slug: str, workspacePath: str = Query('')):
    """Manually delete a single `.aug` artifact."""
    result = augArtifactService.deleteArtifact(workspacePath or None, kind, slug)
    if not result.get('removed') and result.get('error'):
        raise HTTPException(status_code=400, detail=result['error'])
    return result
