"""
Configuration API routes.

Request bodies inherit :class:`CamelModel` so internals are snake_case while
JSON from the frontend stays camelCase.
"""

from __future__ import annotations
from typing import cast
from fastapi import APIRouter, HTTPException
from app.models.camel_base import CamelModel
from app.config import settings
from app.providers import resolver as providerResolver
from app.lib import secrets
from app.services import config_service
from app.json_narrowing import as_dict, as_list, as_str
from app.type_aliases import AliasDict

router = APIRouter(prefix='/api/config')


@router.get('/activeProvider')
async def activeProvider():
    """Get active provider and list all available providers.

    Only returns providers that have API keys configured —
    either built-in providers with keys in config.json/env vars,
    or custom providers from providers.json.
    """
    cfg = config_service.getConfig()
    active = cfg.get('activeProvider')
    providers = []
    for p in providerResolver.list_available():
        apiKey = as_str(as_dict(cfg.get(p['name']), {}).get('apiKey'), '')
        if not apiKey:
            from app.providers.clients import getClient

            client = getClient(p)
            if client:
                apiKey = client.resolveApiKey() or ''
        if apiKey:
            providers.append(
                {
                    'id': p['name'],
                    'name': p['name'],
                    'apiMode': as_str(p.get('apiMode'), ''),
                    'isAvailable': True,
                    'redactedKey': secrets.mask(apiKey),
                }
            )
    store = config_service.getProvidersStore()
    for entry in as_list(store.get('providers'), []):
        name = as_str(entry.get('name'), '')
        if not name or any((p['id'] == name for p in providers)):
            continue
        apiKey = as_str(entry.get('apiKey'), '')
        if apiKey:
            providers.append(
                {
                    'id': name,
                    'name': name,
                    'apiMode': as_str(entry.get('apiFormat'), 'openaiChat'),
                    'isAvailable': True,
                    'redactedKey': secrets.mask(apiKey),
                }
            )
    return {'activeProvider': active, 'providers': providers}


class ProviderDetailsUpdate(CamelModel):
    provider: str
    config: dict[str, str] = {}


@router.get('/provider-details')
async def providerDetails(provider: str = ''):
    """Return details for a user-configured provider (providers.json)."""
    import os
    from app.providers import resolver as providerResolver

    store = config_service.getProvidersStore()
    entry = None
    for raw in as_list(store.get('providers'), []):
        e = as_dict(raw, {})
        if e.get('id') == provider or e.get('name') == provider:
            entry = e
            break
    if not entry:
        raise HTTPException(status_code=404, detail='Provider not found')
    pd = providerResolver.entry_to_provider_dict(entry)
    configOverrides = {
        'apiKey': entry.get('apiKey', ''),
        'baseUrl': entry.get('baseUrl', ''),
    }
    isAvailable = bool(entry.get('enabled')) and bool(entry.get('apiKey'))
    providerId = entry.get('id', provider)
    envVars = as_list(pd.get('envVars'), [])
    envStatus = {as_str(v): bool(os.getenv(as_str(v))) for v in envVars}
    cfg = config_service.getConfig()
    active = cfg.get('activeProvider')
    return {
        'id': providerId,
        'name': pd.get('displayName') or pd.get('name', ''),
        'description': pd.get('description', ''),
        'baseUrl': pd.get('baseUrl', ''),
        'apiMode': pd.get('apiMode', ''),
        'authType': pd.get('authType', 'api_key'),
        'envVars': envVars,
        'envStatus': envStatus,
        'isAvailable': isAvailable,
        'defaultModel': pd.get('defaultModel', ''),
        'signupUrl': pd.get('signupUrl', ''),
        'supportsHealthCheck': pd.get('supportsHealthCheck', False),
        'isActive': active == providerId or active == entry.get('name'),
        'configOverrides': configOverrides,
    }


@router.post('/provider-details')
async def updateProviderDetails(body: ProviderDetailsUpdate):
    """Apply config overrides (api key / base url) to a custom provider entry."""
    from app.services import model_service

    store = config_service.getProvidersStore()
    for raw in as_list(store.get('providers'), []):
        e = as_dict(raw, {})
        if e.get('id') == body.provider or e.get('name') == body.provider:
            if 'apiKey' in body.config:
                e['apiKey'] = body.config['apiKey']
            if body.config.get('baseUrl'):
                e['baseUrl'] = body.config['baseUrl']
            config_service.saveProvidersStore(store)
            model_service.invalidate_cache()
            return {'status': 'success', 'id': e.get('id')}
    raise HTTPException(status_code=404, detail='Provider not found')


@router.get('/safe')
async def configSafe():
    """Get full config (safe endpoint — returns everything the UI needs).

    Used by the frontend to read the active provider and its model settings.
    Returns the full config dict from config.json.
    """
    from app.lib.paths import dataPath
    import json

    cfgPath = dataPath('config.json')
    cfg = json.loads(cfgPath.read_text('utf-8')) if cfgPath.exists() else {}
    return cfg


@router.get('/model-aliases')
async def getModelAliases():
    """Return all model-alias entries for the UI's Aliases tab."""
    from app.services import alias_service

    return {'aliases': alias_service.listAliasesWire()}


class ModelAliasesBulk(CamelModel):
    aliases: list[dict[str, object]]


@router.put('/model-aliases')
async def putModelAliases(body: ModelAliasesBulk):
    """Replace the entire alias list (validated)."""
    from app.services import alias_service

    try:
        replaced = alias_service.replaceAliases(cast(list[AliasDict], body.aliases), actor='ui')
        return {'aliases': [alias_service.alias_to_wire(a) for a in replaced]}
    except ValueError as exc:
        from fastapi import HTTPException

        raise HTTPException(400, detail={'code': 'validation', 'message': str(exc)})


@router.get('/subagent-fallback')
async def getSubagentFallback():
    """Return the current sub-agent fallback configuration."""
    from app.services import fallback_service

    return fallback_service.getFallback()


class FallbackUpdate(CamelModel):
    enabled: bool | None = None
    mode: str | None = None
    provider: str | None = None
    model: str | None = None


@router.put('/subagent-fallback')
async def putSubagentFallback(body: FallbackUpdate):
    """Update sub-agent fallback fields (partial)."""
    from app.services import fallback_service

    try:
        return fallback_service.configureFallback(
            enabled=body.enabled, mode=body.mode, provider=body.provider, model=body.model, actor='ui'
        )
    except ValueError as exc:
        from fastapi import HTTPException

        raise HTTPException(400, detail={'code': 'validation', 'message': str(exc)})


class FallbackTest(CamelModel):
    model: str


@router.post('/subagent-fallback/test')
async def testSubagentFallback(body: FallbackTest):
    """Probe resolution of a model id without saving."""
    from app.services import fallback_service

    return fallback_service.testFallback(body.model)


class BackgroundReviewUpdate(CamelModel):
    """Background review config. Internals snake_case; JSON camelCase."""

    enabled: bool | None = None
    review_model: str | None = None
    reflection_model: str | None = None
    auto_memory_model: str | None = None


@router.get('/background-review')
async def getBackgroundReview():
    """Return the current background review config."""
    from app.services import background_review_service

    return background_review_service.getConfig()


@router.put('/background-review')
async def putBackgroundReview(body: BackgroundReviewUpdate):
    """Update background review config fields (partial)."""
    from app.services import background_review_service

    return background_review_service.saveConfig(
        enabled=body.enabled,
        review_model=body.review_model,
        reflection_model=body.reflection_model,
        auto_memory_model=body.auto_memory_model,
        actor='ui',
    )


@router.get('/model-fleet')
async def getModelFleet():
    """v4.1: Return the merged fleet (defaults + user overrides) — see §10."""
    from app.services import model_fleet_service

    return model_fleet_service.getFleet()


@router.put('/model-fleet')
async def putModelFleet(body: dict[str, object]):
    """v4.1: Update model fleet config (partial).

    Body is a JSON object of any subset of {cortex, cerebellum, hippocampus,
    prefrontal}. Each role must be a string (empty allowed for `cortex`,
    which means "use the session's primary model"). Unknown roles are
    rejected with 400.

    We accept `dict` rather than a strict pydantic model so the service
    layer can return a single 400 with the offending role name (pydantic
    would 422 with a generic shape error).
    """
    from fastapi import HTTPException
    from app.services import model_fleet_service

    ok, err, fleet = model_fleet_service.updateFleet(body)
    if not ok:
        raise HTTPException(status_code=400, detail={'code': 'validation', 'message': err})
    return fleet


@router.get('/cognitive')
async def getCognitiveConfig():
    """Single cognitive config tree (boot, features, fleet, orchestrator)."""
    from app.services.cognitive_config import to_public, ensure_defaults

    ensure_defaults()
    return to_public()


@router.put('/cognitive')
async def putCognitiveConfig(body: dict[str, object]):
    """Partial update of the cognitive config tree."""
    from app.services.cognitive_config import update_cognitive

    return update_cognitive(body)


@router.get('/session-export')
async def getSessionExportConfig():
    """Admin: whether continuous JSON session backup export is enabled.

    SQLite remains the session SoT. JSON is optional backup only.
    """
    from app.services.workbench.sessions import get_session_json_export_status

    return get_session_json_export_status()


@router.put('/session-export')
async def putSessionExportConfig(body: dict[str, object]):
    """Admin: set continuous JSON session export on/off (config-backed).

    Body: ``{ "enabled": true|false }``. Env ``AUGUST_SESSION_JSON_EXPORT``
    still overrides when set. Optional ``exportNow: true`` writes one snapshot.
    """
    from fastapi import HTTPException
    from app.services.workbench.sessions import (
        set_session_json_export_enabled,
        export_sessions_json,
        get_session_json_export_status,
    )

    if 'enabled' not in body or not isinstance(body.get('enabled'), bool):
        raise HTTPException(
            status_code=400,
            detail={'code': 'validation', 'message': 'enabled must be a boolean'},
        )
    status = set_session_json_export_enabled(bool(body['enabled']))
    if body.get('exportNow') is True:
        path = export_sessions_json()
        status = get_session_json_export_status()
        status['exportedPath'] = str(path)
    return status


@router.get('/live')
async def getLiveConfig():
    """v4.2: Return the Live config (defaults + user overrides) — see §14.

    An empty `sttProvider`/`ttsProvider` means "use the browser default"
    (Web Speech API). Setting a provider upgrades to a paid service.
    """
    from app.services import live_config_service

    return live_config_service.getLiveConfigWithStatus()


@router.put('/live')
async def putLiveConfig(body: dict[str, object]):
    """v4.2: Update Live config (partial). Response includes readiness flags."""
    from fastapi import HTTPException
    from app.services import live_config_service

    clean = {k: v for k, v in body.items() if k in live_config_service.FIELDS}
    ok, err, _cfg = live_config_service.updateLiveConfig(clean)
    if not ok:
        raise HTTPException(status_code=400, detail={'code': 'validation', 'message': err})
    return live_config_service.getLiveConfigWithStatus()


@router.get('/web')
async def getWebConfig():
    """Return web search/extract config (backends + compress thresholds)."""
    from app.services import web_config_service

    return web_config_service.get_web_config_with_status()


@router.put('/web')
async def putWebConfig(body: dict[str, object]):
    """Partial update of ``auxiliary.web`` (backend, keys, compress knobs)."""
    from fastapi import HTTPException
    from app.services import web_config_service

    clean = {k: v for k, v in body.items() if k in web_config_service.DEFAULTS}
    ok, err, _cfg = web_config_service.update_web_config(clean)
    if not ok:
        raise HTTPException(status_code=400, detail={'code': 'validation', 'message': err})
    return web_config_service.get_web_config_with_status()


def _resolve_gateway_key() -> tuple[str | None, str | None]:
    """Return (key, source) where source is env|config|None."""
    from app.lib.gateway_auth import resolve_gateway_api_key
    import os

    env_key = (settings.gatewayApiKey or os.environ.get('GATEWAY_API_KEY') or '').strip()
    if env_key:
        return env_key, 'env'
    key = resolve_gateway_api_key()
    if key:
        return key, 'config'
    return None, None


@router.get('/external-access')
async def getExternalAccess():
    """Return current external-access config.

    Includes:
      - enabled:        whether the gateway is open for external clients
      - hasKey:         whether a gateway key is configured server-side
      - keyPreview:     masked preview of the key (or null)
      - endpoints:      the URLs to give to external clients
      - source:         where the key is loaded from ('env'|'config'|null)
    """
    cfg = config_service.getConfig()
    gw = as_dict(cfg.get('gateway'), {})
    ea = as_dict(gw.get('externalAccess'), {})
    enabled = bool(ea.get('enabled', False))
    apiKey, source = _resolve_gateway_key()
    return {
        'enabled': enabled,
        'hasKey': bool(apiKey),
        'keyPreview': secrets.mask(apiKey) if apiKey else None,
        'source': source,
        'endpoints': {
            'anthropic': f'http://localhost:{settings.port}/v1/messages',
            'openai': f'http://localhost:{settings.port}/v1/chat/completions',
            'models': f'http://localhost:{settings.port}/v1/models',
        },
    }


class ExternalAccessUpdate(CamelModel):
    enabled: bool


class InjectAugOnProxyUpdate(CamelModel):
    """Toggle optional AUG.md injection on /v1 proxy paths."""

    enabled: bool


@router.get('/inject-aug-on-proxy')
async def get_inject_aug_on_proxy():
    """Return whether proxy-path AUG.md injection is enabled (default false)."""
    cfg = config_service.getConfig()
    enabled = bool(cfg.get('injectAugOnProxy') or cfg.get('inject_aug_on_proxy'))
    return {'enabled': enabled}


@router.put('/inject-aug-on-proxy')
async def put_inject_aug_on_proxy(body: InjectAugOnProxyUpdate):
    """Enable/disable injecting AUG.md into /v1/messages and /v1/chat/completions."""
    cfg = config_service.getConfig()
    cfg['injectAugOnProxy'] = bool(body.enabled)
    # Drop legacy snake key if present so one source of truth remains.
    cfg.pop('inject_aug_on_proxy', None)
    config_service.saveConfig(cfg)
    try:
        settings.reload()
    except Exception:
        pass
    return {'enabled': bool(cfg['injectAugOnProxy'])}


@router.put('/external-access')
async def putExternalAccess(body: ExternalAccessUpdate):
    """Toggle external API gateway access on/off."""
    apiKey, source = _resolve_gateway_key()
    if body.enabled and (not apiKey):
        raise HTTPException(
            status_code=400,
            detail={
                'code': 'no_api_key',
                'message': 'Cannot enable external access: no gateway key. Generate one in Settings → API Access.',
            },
        )
    cfg = config_service.getConfig()
    gw = as_dict(cfg.setdefault('gateway', {}), {})
    ea = as_dict(gw.setdefault('externalAccess', {}), {})
    ea['enabled'] = bool(body.enabled)
    config_service.saveConfig(cfg)
    settings.reload()
    apiKey, source = _resolve_gateway_key()
    return {
        'enabled': ea['enabled'],
        'hasKey': bool(apiKey),
        'keyPreview': secrets.mask(apiKey) if apiKey else None,
        'source': source,
    }


@router.post('/external-access/generate-key')
async def generateGatewayApiKey():
    """Generate a new gateway API key and persist it (config + .env best-effort).

    Returns the full key **once** so the UI can show/copy it. Subsequent GETs
    only return a masked preview.
    """
    import os
    import secrets as py_secrets
    from pathlib import Path

    # url-safe token; prefix for easy identification in logs
    raw = 'aug_' + py_secrets.token_urlsafe(32)
    cfg = config_service.getConfig()
    gw = as_dict(cfg.setdefault('gateway', {}), {})
    gw['apiKey'] = raw
    config_service.saveConfig(cfg)

    # Live process
    settings.gatewayApiKey = raw
    os.environ['GATEWAY_API_KEY'] = raw

    # Best-effort write/update project .env so restarts keep the key
    try:
        root = Path(settings.projectRoot)
        env_path = root / '.env'
        lines: list[str] = []
        if env_path.is_file():
            lines = env_path.read_text('utf-8').splitlines()
        out: list[str] = []
        found = False
        for line in lines:
            if line.strip().startswith('GATEWAY_API_KEY='):
                out.append(f'GATEWAY_API_KEY={raw}')
                found = True
            else:
                out.append(line)
        if not found:
            if out and out[-1].strip():
                out.append('')
            out.append(f'GATEWAY_API_KEY={raw}')
        env_path.write_text('\n'.join(out) + '\n', encoding='utf-8')
    except Exception:
        pass

    try:
        settings.reload()
        # Keep the generated key after reload (reload re-reads .env)
        if not settings.gatewayApiKey:
            settings.gatewayApiKey = raw
    except Exception:
        settings.gatewayApiKey = raw

    return {
        'apiKey': raw,
        'hasKey': True,
        'keyPreview': secrets.mask(raw),
        'source': 'config',
        'message': 'Key generated. Copy it now — it will not be shown in full again.',
    }
