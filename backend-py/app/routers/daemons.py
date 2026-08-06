"""Daemon control API (D11) — spawn/kill/list the subconscious daemons.

Previously daemons were agent-tool-only; this gives the UI (Brain → Runs)
direct control over the same DaemonManager.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.json_narrowing import as_str

router = APIRouter(prefix='/api/daemons')


@router.get('')
async def listDaemons(sessionId: str = ''):
    """List registered daemons (optionally filtered by session)."""
    from app.services.daemon_manager import getManager

    return {'daemons': getManager().list_daemons(sessionId or None)}


@router.post('')
async def spawnDaemon(body: dict, sessionId: str = 'default'):
    """Spawn a daemon.

    Body: ``{ "name": str, "prompt": str, "watchCondition"?: str }`` —
    watchCondition is evaluated each poll (e.g. ``on_change``, keywords).
    """
    from app.services.daemon_manager import DaemonSpec, getManager

    name = as_str(body.get('name'), '').strip() or 'watcher'
    prompt = as_str(body.get('prompt'), '').strip()
    if not prompt:
        raise HTTPException(status_code=400, detail='prompt is required')
    spec = DaemonSpec(
        name=name[:40],
        prompt=prompt[:2000],
        watchCondition=as_str(body.get('watchCondition'), '').strip() or None,
    )
    result = await getManager().spawn(spec, sessionId)
    if result.startswith('Error:'):
        raise HTTPException(status_code=400, detail=result)
    return {'daemonId': result}


@router.post('/{daemon_id}/kill')
async def killDaemon(daemon_id: str):
    """Kill a running daemon."""
    from app.services.daemon_manager import getManager

    if not await getManager().kill(daemon_id):
        raise HTTPException(status_code=404, detail='Daemon not found')
    return {'killed': True}
