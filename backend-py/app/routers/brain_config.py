"""
Brain Orchestrator settings-tab HTTP API.

Mounts four routes under ``/api/brain``:

  GET  /api/brain/config                — { source, config, defaults, sessionId?, session? }
  PUT  /api/brain/config                — { ok, config, defaults }           (400 on bad patch)
  POST /api/brain/config/reset          — { ok, config, defaults }
  GET  /api/brain/config/from-session   — { source, config, defaults, sessionId, session }
  GET  /api/brain/stores                — per-store counts for the Memory settings page
  GET  /api/brain/stores/{name}         — paginated rows of one store (read-only browse)
  DELETE /api/brain/stores/{name}/{id}  — delete one row (per-entry Delete in the UI)
  PATCH  /api/brain/stores/{name}/{id}  — update whitelisted fields of one row

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


@router.get('/stores')
async def getBrainStores():
    """Per-store row counts — the Memory settings page header chips."""
    from app.services.memory_store.brain import brain_store_summary

    return {'stores': brain_store_summary()}


@router.get('/stores/{name}')
async def getBrainStore(
    name: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    query: str = Query('', max_length=200),
):
    """Read-only paginated browse of one brain store (Memory settings page)."""
    from app.services.memory_store.brain import brain_browse

    result = brain_browse(name, limit=limit, offset=offset, query=query)
    if result.get('error') and not result.get('total') and 'not available' in str(result.get('error')):
        raise HTTPException(status_code=404, detail=result['error'])
    return result


@router.delete('/stores/{name}/{row_id:path}')
async def deleteBrainStoreRow(name: str, row_id: str):
    """Delete one row from a brain store (per-entry Delete in the Memory UI).

    ``row_id`` is the store's identifier column (``id`` for most stores, the
    ``key`` for the KV memory store). Read-only/legacy stores return 403.
    """
    from app.services.memory_store.brain import brain_delete_row

    result = brain_delete_row(name, row_id)
    if result.get('status') == 403:
        raise HTTPException(status_code=403, detail=result.get('error'))
    if not result.get('ok'):
        err = str(result.get('error') or 'delete failed')
        raise HTTPException(status_code=404 if 'not found' in err else 400, detail=err)
    return result


@router.patch('/stores/{name}/{row_id:path}')
async def updateBrainStoreRow(name: str, row_id: str, body: dict[str, object]):
    """Update whitelisted fields of one brain-store row (Memory UI inline edit).

    Only the store's whitelisted columns are applied; unknown fields are
    ignored. Read-only/legacy stores return 403.
    """
    from app.services.memory_store.brain import brain_update_row

    result = brain_update_row(name, row_id, body or {})
    if result.get('status') == 403:
        raise HTTPException(status_code=403, detail=result.get('error'))
    if not result.get('ok'):
        err = str(result.get('error') or 'update failed')
        raise HTTPException(status_code=404 if 'not found' in err else 400, detail=err)
    return result
