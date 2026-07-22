"""
Management endpoints — /api/manage/*

Resources that don't fit existing routers: aliases, settings, snapshot.
"""

from __future__ import annotations
import json
from fastapi import APIRouter, HTTPException
from app.config import settings
from app.atomic_write import write_json_atomic
from app.models.camel_base import CamelModel
from app.providers import resolver as providerResolver
from app.services.memory_store import get_stats
from app.services.workbench.workbench import listWorkbenchSessions

router = APIRouter(prefix='/api/manage')


class AliasCreate(CamelModel):
    alias: str
    target_model: str
    target_provider: str = ''


class AliasUpdate(CamelModel):
    target_model: str | None = None
    target_provider: str | None = None


class SettingsUpdate(CamelModel):
    updates: dict[str, object]


def _readAliases() -> list[dict[str, object]]:
    from app.lib.paths import dataPath

    p = dataPath('config.json')
    if not p.exists():
        return []
    cfg = json.loads(p.read_text('utf-8'))
    return cfg.get('modelAliases', [])


def _writeAliases(aliases: list[dict[str, object]]) -> None:
    from app.lib.paths import dataPath

    p = dataPath('config.json')
    cfg = json.loads(p.read_text('utf-8')) if p.exists() else {}
    cfg['modelAliases'] = aliases
    write_json_atomic(p, cfg, indent=2)
    settings.reload()


def _err(code: str, message: str, status: int = 404) -> HTTPException:
    return HTTPException(status_code=status, detail={'code': code, 'message': message})


@router.get('/snapshot')
async def snapshot():
    """Full state snapshot for the UI's initial page load."""
    providers = providerResolver.list_available()
    return {
        'providers': [
            {
                'id': p.get('name', ''),
                'name': p.get('name', ''),
                'description': p.get('description', ''),
                'baseUrl': p.get('baseUrl', ''),
                'apiFormat': p.get('apiMode', ''),
                'defaultModel': p.get('defaultModel', ''),
                'enabled': True,
                'models': list(p.get('modelProfiles', {}).keys()),
            }
            for p in providers
        ],
        'sessions': listWorkbenchSessions(),
        'memory': get_stats(),
    }


@router.get('/aliases')
async def listAliases():
    """List all model aliases."""
    return _readAliases()


@router.post('/aliases')
async def createAlias(body: AliasCreate):
    """Create or update a model alias."""
    aliases = _readAliases()
    entry: dict[str, object] = {
        'alias': body.alias,
        'targetModel': body.target_model,
        'targetProvider': body.target_provider,
    }
    existing = next((a for a in aliases if a.get('alias') == body.alias), None)
    if existing:
        existing.update(entry)
    else:
        aliases.append(entry)
    _writeAliases(aliases)
    return entry


@router.put('/aliases/{alias_name}')
async def updateAlias(alias_name: str, body: AliasUpdate):
    """Update a model alias."""
    aliases = _readAliases()
    existing = next((a for a in aliases if a.get('alias') == alias_name), None)
    if not existing:
        raise _err('not_found', 'Alias not found')
    if body.target_model is not None:
        existing['targetModel'] = body.target_model
    if body.target_provider is not None:
        existing['targetProvider'] = body.target_provider
    _writeAliases(aliases)
    return existing


@router.delete('/aliases/{alias_name}')
async def deleteAlias(alias_name: str):
    """Delete a model alias."""
    aliases = _readAliases()
    before = len(aliases)
    aliases = [a for a in aliases if a.get('alias') != alias_name]
    if len(aliases) == before:
        raise _err('not_found', 'Alias not found')
    _writeAliases(aliases)
    return {'deleted': True}


@router.put('/settings')
async def updateSettings(body: SettingsUpdate):
    """Bulk-update application settings (deep merge into config.json)."""
    from app.lib.paths import dataPath

    p = dataPath('config.json')
    cfg = json.loads(p.read_text('utf-8')) if p.exists() else {}

    def deepSet(target: dict, keys: list[str], value: object) -> None:
        for key in keys[:-1]:
            target = target.setdefault(key, {})
        target[keys[-1]] = value

    for keyPath, value in body.updates.items():
        deepSet(cfg, keyPath.split('.'), value)
    write_json_atomic(p, cfg, indent=2)
    settings.reload()
    return {'updated': list(body.updates.keys())}
