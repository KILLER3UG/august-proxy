"""AUG routes — AUG.md management.

Endpoints:
  GET  /api/aug/context                 → current AUG.md { exists, body, frontmatter, path }
  POST /api/aug/init                    → LLM draft { draft, existing, analysis, mode }
  PUT  /api/aug/content                 → write AUG.md { path, bytes }
  DELETE /api/aug/content               → remove AUG.md { path, removed }
"""

from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Query

from app.json_narrowing import as_str
from app.services import aug_directive_service

router = APIRouter(prefix='/api/aug')


@router.get('/context')
async def getAugContext(workspacePath: str = Query('', description='Workspace path (falls back to project root)')):
    """Return the current AUG.md for a workspace."""
    loaded = aug_directive_service.load(workspacePath or None)
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
    if mode == 'refine' and not aug_directive_service.exists(workspacePath or None):
        mode = 'create'
    existing = None
    if mode == 'refine':
        loaded = aug_directive_service.load(workspacePath or None)
        existing = as_str(loaded['body']) if loaded else None
    try:
        result = await aug_directive_service.generate(workspacePath, mode=mode, existing=existing, model=model)
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
        result = aug_directive_service.write(workspacePath, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Prompt cache is content-hash keyed — no manual invalidation needed.
    return result


@router.delete('/content')
async def deleteAugContent(workspacePath: str = Query('')):
    """Remove the workspace AUG.md if present."""
    return aug_directive_service.delete(workspacePath or None)
