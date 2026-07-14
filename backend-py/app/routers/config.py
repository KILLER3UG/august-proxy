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
    """Return resolver-derived details for a provider (custom entry or template).

    Used by the provider settings UI to show description, auth type, env
    readiness, signup link, and any config overrides (api key / base url).
    """
    import os
    from app.providers import resolver as providerResolver
    from app.providers.template_loader import get_templates, get_template

    store = config_service.getProvidersStore()
    entry = None
    for raw in as_list(store.get('providers'), []):
        e = as_dict(raw, {})
        if e.get('id') == provider or e.get('name') == provider:
            entry = e
            break
    if entry:
        pd = providerResolver._customEntryToProviderDict(entry)
        configOverrides = {
            'apiKey': entry.get('apiKey', ''),
            'baseUrl': entry.get('baseUrl', ''),
        }
        isAvailable = bool(entry.get('enabled')) and bool(entry.get('apiKey'))
        providerId = entry.get('id', provider)
    else:
        tmpl = get_template(provider)
        if not tmpl:
            for t in get_templates():
                if t.get('id') == provider or t.get('name') == provider:
                    tmpl = t
                    break
        if not tmpl:
            raise HTTPException(status_code=404, detail='Provider not found')
        pd = providerResolver._templateToProviderDict(tmpl)
        configOverrides = {}
        isAvailable = False
        providerId = tmpl.get('id', provider)
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
        'isActive': active == providerId,
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


@router.get('/live')
async def getLiveConfig():
    """v4.2: Return the Live config (defaults + user overrides) — see §14.

    An empty `sttProvider`/`ttsProvider` means "use the browser default"
    (Web Speech API). Setting a provider upgrades to a paid service.
    """
    from app.services import live_config_service

    return live_config_service.getLiveConfig()


@router.put('/live')
async def putLiveConfig(body: dict[str, object]):
    """v4.2: Update Live config (partial).

    Body may contain any subset of {sttProvider, sttModel, ttsProvider,
    ttsModel, ttsVoice}. Each field is a string; empty values mean
    "browser default."
    """
    from fastapi import HTTPException
    from app.services import live_config_service

    ok, err, cfg = live_config_service.updateLiveConfig(body)
    if not ok:
        raise HTTPException(status_code=400, detail={'code': 'validation', 'message': err})
    return cfg


@router.get('/external-access')
async def getExternalAccess():
    """Return current external-access config.

    Includes:
      - enabled:        whether the gateway is open for external clients
      - hasKey:         whether GATEWAY_API_KEY is configured server-side
      - keyPreview:     masked preview of the key (or null)
      - endpoints:      the URLs to give to external clients
      - source:         where the key is loaded from ('env'|'config'|null)
    """
    cfg = config_service.getConfig()
    gw = as_dict(cfg.get('gateway'), {})
    ea = as_dict(gw.get('externalAccess'), {})
    enabled = bool(ea.get('enabled', False))
    apiKey = settings.gatewayApiKey
    return {
        'enabled': enabled,
        'hasKey': bool(apiKey),
        'keyPreview': secrets.mask(apiKey) if apiKey else None,
        'source': 'env' if apiKey else None,
        'endpoints': {
            'anthropic': f'http://localhost:{settings.port}/v1/messages',
            'openai': f'http://localhost:{settings.port}/v1/chat/completions',
            'models': f'http://localhost:{settings.port}/v1/models',
        },
    }


class ExternalAccessUpdate(CamelModel):
    enabled: bool


@router.put('/external-access')
async def putExternalAccess(body: ExternalAccessUpdate):
    """Toggle external API gateway access on/off.

    The ``GATEWAY_API_KEY`` itself is not part of this payload — it lives
    in ``.env`` (or system environment) and is managed outside the app.
    """
    if body.enabled and (not settings.gatewayApiKey):
        raise HTTPException(
            status_code=400,
            detail={
                'code': 'no_api_key',
                'message': 'Cannot enable external access: GATEWAY_API_KEY is not configured. Set it in your .env file and restart the proxy.',
            },
        )
    cfg = config_service.getConfig()
    gw = as_dict(cfg.setdefault('gateway', {}), {})
    ea = as_dict(gw.setdefault('externalAccess', {}), {})
    ea['enabled'] = bool(body.enabled)
    config_service.saveConfig(cfg)
    settings.reload()
    return {
        'enabled': ea['enabled'],
        'hasKey': bool(settings.gatewayApiKey),
        'keyPreview': secrets.mask(settings.gatewayApiKey) if settings.gatewayApiKey else None,
        'source': 'env' if settings.gatewayApiKey else None,
    }
