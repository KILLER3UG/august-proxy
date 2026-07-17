"""
/api/august routes — alias management action endpoint + config audit log.

These endpoints match the shapes the existing frontend already calls
(``manageAugustAliases`` → ``POST /api/august/aliases/manage`` and the
audit viewer → ``GET /api/august/audit``), so the UI stops 404'ing against
the Python backend.

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase (``targetModel``, ``displayAlias``, etc.).
"""

from __future__ import annotations
from typing import cast
from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.services import alias_service
from app.services.memory_store import list_config_audit
from app.type_aliases import JsonValue

router = APIRouter(prefix='/api/august')


class AliasManageItem(CamelModel):
    """Single alias entry. Internals are snake_case; JSON stays camelCase."""

    alias: str
    target_model: str = ''
    target_provider: str = ''
    display_alias: str = ''


class AliasManageRequest(CamelModel):
    """Alias manage body. Internals are snake_case; JSON stays camelCase."""

    action: str
    alias: str | None = None
    target_model: str | None = None
    target_provider: str | None = None
    display_alias: str | None = None
    items: list[AliasManageItem] | None = None


@router.post('/aliases/manage')
async def manageAliases(body: AliasManageRequest):
    """Unified alias action endpoint used by the frontend's AliasesTab."""
    action = (body.action or '').lower()
    if action == 'list':
        return {'aliases': alias_service.listAliasesWire()}
    if action == 'upsert':
        alias = (body.alias or '').strip()
        if not alias:
            raise HTTPException(400, detail={'code': 'bad_request', 'message': 'alias is required'})
        try:
            entry = alias_service.createAlias(
                alias=alias,
                target_model=body.target_model or '',
                target_provider=body.target_provider or '',
                display_alias=body.display_alias or '',
                actor='ui',
            )
        except ValueError as exc:
            raise HTTPException(400, detail={'code': 'validation', 'message': str(exc)})
        return {'alias': alias_service.alias_to_wire(entry)}
    if action == 'delete':
        if not body.alias:
            raise HTTPException(400, detail={'code': 'bad_request', 'message': 'alias is required'})
        removed = alias_service.delete_alias(body.alias, actor='ui')
        return {'deleted': removed, 'alias': body.alias}
    raise HTTPException(400, detail={'code': 'bad_request', 'message': f"Unknown action '{action}'"})


@router.get('/audit')
async def auditLog(category: str = '', limit: int = 200) -> dict[str, object]:
    """Return config-change audit entries shaped for the frontend AuditEntry view."""
    limit = max(1, min(limit, 1000))
    rows = list_config_audit(category=category, limit=limit)
    entries = []
    for r in rows:
        entries.append(
            {
                'id': r.get('id'),
                'category': r.get('category'),
                'action': r.get('action'),
                'actor': r.get('actor', ''),
                'before': r.get('before'),
                'after': r.get('after'),
                'createdAt': r.get('createdAt'),
            }
        )
    return {'entries': entries, 'count': len(entries)}


@router.get('/rollback')
async def rollbackList() -> dict[str, object]:
    """Rollback is out of scope for this pass — return an empty list."""
    return {'entries': [], 'count': 0}


# ── Manage action endpoints used by the desktop API client ─────────────


class SettingsUpdateBody(CamelModel):
    key_path: str = ''
    value: object = None


class ModelSelectBody(CamelModel):
    model: str = ''
    provider: str = ''


class ActionBody(CamelModel):
    action: str = ''
    id: str | None = None
    title: str | None = None
    updates: dict[str, object] | None = None
    provider: dict[str, object] | None = None
    agent: dict[str, object] | None = None
    key: str | None = None
    value: object = None
    category: str | None = None
    ttl_days: int | None = None
    kind: str | None = None
    name: str | None = None
    config: dict[str, object] | None = None
    app: str | None = None
    policy: str | None = None


@router.post('/settings/update')
async def update_settings(body: SettingsUpdateBody):
    from app.services.config_service import getConfig, saveConfig

    if not body.key_path:
        raise HTTPException(400, detail='keyPath is required')
    cfg = getConfig()
    keys = body.key_path.split('.')
    cur: dict = cfg
    for k in keys[:-1]:
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[keys[-1]] = body.value
    saveConfig(cfg)
    return {'ok': True, 'keyPath': body.key_path, 'value': body.value}


@router.post('/models/select')
async def select_model(body: ModelSelectBody):
    from app.services.config_service import getConfig, saveConfig

    cfg = getConfig()
    cfg['activeModel'] = body.model
    if body.provider:
        cfg['activeProvider'] = body.provider
    saveConfig(cfg)
    return {'ok': True, 'model': body.model, 'provider': body.provider}


@router.post('/sessions/manage')
async def manage_sessions(body: ActionBody):
    from app.services.workbench import workbench as wb

    action = (body.action or '').lower()
    if action == 'list':
        return {'ok': True, 'sessions': wb.listWorkbenchSessions()}
    if action == 'create':
        s = wb.createWorkbenchSession()
        return {'ok': True, 'session': s.toDict()}
    if action in ('delete', 'archive') and body.id:
        ok = wb.deleteWorkbenchSession(body.id)
        return {'ok': ok, 'id': body.id}
    if action == 'rename' and body.id and body.title:
        from app.services.workbench.sessions import rename_workbench_session

        renamed = rename_workbench_session(str(body.id), str(body.title))
        if not renamed:
            raise HTTPException(404, detail='Session not found')
        return {'ok': True, 'session': renamed.toDict()}
    return {'ok': True, 'sessions': wb.listWorkbenchSessions()}


@router.post('/providers/manage')
async def manage_providers(body: ActionBody):
    from app.services.config_service import getProvidersStore, saveProvidersStore
    from app.json_narrowing import as_list

    store = getProvidersStore()
    providers = list(as_list(store.get('providers')))
    action = (body.action or '').lower()
    if action == 'upsert' and body.provider:
        pid = str(body.provider.get('id') or body.provider.get('name') or '')
        replaced = False
        for i, p in enumerate(providers):
            if isinstance(p, dict) and str(p.get('id') or p.get('name')) == pid:
                providers[i] = {**p, **body.provider}
                replaced = True
                break
        if not replaced:
            providers.append(body.provider)
        store['providers'] = providers
        saveProvidersStore(store)
        return {'ok': True, 'provider': body.provider}
    if action == 'delete' and body.id:
        store['providers'] = [
            p
            for p in providers
            if not (isinstance(p, dict) and str(p.get('id') or p.get('name')) == body.id)
        ]
        saveProvidersStore(store)
        return {'ok': True, 'deleted': True, 'id': body.id}
    return {'ok': True, 'providers': providers}


@router.post('/agents/manage')
async def manage_agents(body: ActionBody):
    from app.services.tools import agent_registry
    from app.services.config_service import getConfig, saveConfig
    from app.json_narrowing import as_list, as_dict

    action = (body.action or '').lower()
    cfg = getConfig()
    custom = [as_dict(a) for a in as_list(cfg.get('customAgents'))]
    if action == 'upsert' and body.agent:
        aid = str(body.agent.get('id') or body.agent.get('name') or '')
        replaced = False
        for i, a in enumerate(custom):
            if str(a.get('id') or a.get('name')) == aid:
                custom[i] = {**a, **body.agent}
                replaced = True
                break
        if not replaced:
            custom.append(dict(body.agent))
        cfg['customAgents'] = custom
        saveConfig(cfg)
        return {'ok': True, 'agent': body.agent}
    if action == 'delete' and body.id:
        try:
            agent_registry.deleteAgent(body.id)
        except Exception:
            pass
        cfg['customAgents'] = [
            a for a in custom if str(a.get('id') or a.get('name')) != body.id
        ]
        saveConfig(cfg)
        return {'ok': True, 'deleted': True, 'id': body.id}
    agents = list(agent_registry.listAgents()) + custom
    return {'ok': True, 'agents': agents}


@router.post('/memory/manage')
async def manage_memory(body: ActionBody):
    from app.services import memory_store

    action = (body.action or '').lower()
    key = body.key or ''
    if action in ('set', 'upsert') and key:
        memory_store.save_fact(key, cast(JsonValue, body.value), category=body.category or 'general')
        return {'ok': True, 'key': key, 'value': body.value}
    if action in ('delete', 'forget') and key:
        memory_store.delete_fact(key)
        return {'ok': True, 'key': key}
    return {'ok': False}


@router.post('/tools/manage')
async def manage_tools(body: ActionBody):
    from app.json_narrowing import as_dict, as_list
    from app.services.tools import mcp_client

    action = (body.action or '').lower()
    if action == 'list':
        return {'ok': True, 'tools': mcp_client.listRegisteredServers()}
    if action == 'upsert' and body.name:
        cfg = body.config or {}
        server = mcp_client.registerServer(
            body.name,
            str(cfg.get('command') or 'true'),
            args=[str(a) for a in as_list(cfg.get('args'), [])] if isinstance(cfg.get('args'), list) else None,
            env={str(k): str(v) for k, v in as_dict(cfg.get('env'), {}).items()} if isinstance(cfg.get('env'), dict) else None,
        )
        return {'ok': True, 'tool': server}
    if action == 'delete' and body.name:
        # match by name
        for s in mcp_client.listRegisteredServers():
            if s.get('name') == body.name or s.get('id') == body.name:
                mcp_client.unregisterServer(str(s.get('id')))
                return {'ok': True, 'deleted': True, 'name': body.name}
        return {'ok': False, 'name': body.name}
    return {'ok': True}


@router.post('/computer/app-policy')
async def computer_app_policy(body: ActionBody):
    from app.services.config_service import getConfig, saveConfig
    from app.json_narrowing import as_dict

    cfg = getConfig()
    policies = as_dict(cfg.get('appPolicies')) if cfg.get('appPolicies') is not None else {}
    action = (body.action or '').lower()
    if action == 'list':
        return {'ok': True, 'policies': policies}
    if action == 'set' and body.app and body.policy:
        policies[body.app] = body.policy
        cfg['appPolicies'] = policies
        saveConfig(cfg)
        return {'ok': True, 'app': body.app, 'policy': body.policy}
    if action == 'delete' and body.app:
        policies.pop(body.app, None)
        cfg['appPolicies'] = policies
        saveConfig(cfg)
        return {'ok': True, 'app': body.app}
    return {'ok': True, 'policies': policies}


@router.post('/ui-action')
async def ui_action(body: dict[str, object]):
    """Accept UI action events (frontend also dispatches locally)."""
    return {'ok': True, 'received': body}


@router.get('/ui-events')
async def ui_events(since: str = ''):
    """No server-side UI event bus yet — empty stream for pollers."""
    return {'ok': True, 'events': [], 'since': since}


@router.post('/rollback/{entry_id}/undo')
async def undo_rollback(entryId: str):
    return {'ok': False, 'entry': None, 'id': entryId, 'message': 'No rollback entry'}

