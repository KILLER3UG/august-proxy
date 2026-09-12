"""Skill-pack install-from-remote endpoints.

Prefix-safe: the main app includes this router BEFORE ``/api/skills`` so
``GET /api/skills/packs`` never gets swallowed by the skills detail route
``GET /api/skills/{name}`` (static-vs-param collision).
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Body, HTTPException

router = APIRouter(prefix='/api/skills/packs', tags=['skill-packs'])


@router.get('')
async def packs_list() -> dict[str, Any]:
    from app.services import skill_packs

    return {'packs': await asyncio.to_thread(skill_packs.list_packs)}


@router.post('')
async def packs_install(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    source = str(payload.get('source') or '').strip()
    if not source:
        raise HTTPException(status_code=400, detail='source is required')
    from app.services import skill_packs

    try:
        return await asyncio.to_thread(skill_packs.install_pack, source)
    except ValueError as exc:
        return {'ok': False, 'error': str(exc)}


@router.delete('/{name}')
async def packs_uninstall(name: str) -> dict[str, Any]:
    from app.services import skill_packs

    result = await asyncio.to_thread(skill_packs.uninstall_pack, name)
    if not result.get('ok'):
        raise HTTPException(status_code=404, detail=str(result.get('error') or 'unknown pack'))
    return result
