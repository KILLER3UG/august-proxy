"""
Brain Orchestrator settings-tab HTTP API.

Mounts four routes under ``/api/brain``:

  GET  /api/brain/config                — { source, config, defaults, sessionId?, session? }
  PUT  /api/brain/config                — { ok, config, defaults }           (400 on bad patch)
  POST /api/brain/config/reset          — { ok, config, defaults }
  GET  /api/brain/config/from-session   — { source, config, defaults, sessionId, session }

The shared service is :mod:`app.services.brain_config_service`. Mutation
endpoints record an audit row via ``memory_store.record_config_audit``.

Handler functions use camelCase to match the project-wide convention. URL
paths and JSON wire-format keys remain snake_case (FastAPI path params,
HTTP method semantics, and the ``auxiliary.cognitive.orchestrator`` SoT
must stay backward-compatible).

Port of the deleted Node.js ``backend/index.js`` brain-config block
(commit 6d61910, 2026-06-21).
"""

from __future__ import annotations
from fastapi import APIRouter, HTTPException, Query
from app.services import brain_config_service

router = APIRouter(prefix='/api/brain', tags=['brain-config'])


@router.get('/config')
async def getBrainConfig():
    """Return the effective brain config + defaults + source tag + session
    info. The React ``BrainSettings`` page calls this on mount."""
    return brain_config_service.getBrainConfigForSettings()


@router.put('/config')
async def putBrainConfig(body: dict[str, object]):
    """Apply a partial patch to ``auxiliary.cognitive.orchestrator``.

    Body must be a JSON object whose keys are a subset of the 11 known
    fields (9 booleans + 2 numeric limits). Unknown keys, wrong types, or
    out-of-range numbers → HTTP 400 with ``{code, message}``.
    """
    ok, err, merged = brain_config_service.saveBrainConfig(body or {})
    if not ok:
        raise HTTPException(
            status_code=400, detail={'code': 'EBRAIN_UNKNOWN_KEY' if 'unknown' in err else 'validation', 'message': err}
        )
    return {'ok': True, 'config': merged, 'defaults': brain_config_service.getDefaults()}


@router.post('/config/reset')
async def postBrainConfigReset():
    """Clear ``auxiliary.cognitive.orchestrator`` and return the factory defaults."""
    ok, defaults = brain_config_service.resetBrainConfig()
    return {'ok': ok, 'config': defaults, 'defaults': defaults}


@router.get('/config/from-session')
async def getBrainConfigFromSession(sessionId: str = Query(..., min_length=1)):
    """Return the brain config tagged ``source='session'`` for a specific
    workbench session. ``sessionId`` is required (400 if missing)."""
    if not sessionId:
        raise HTTPException(
            status_code=400, detail={'code': 'validation', 'message': 'sessionId query param is required'}
        )
    return brain_config_service.getBrainConfigFromSession(sessionId)
