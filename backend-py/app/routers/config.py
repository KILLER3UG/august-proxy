"""
Configuration API routes.
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.config import settings
from app.providers import resolver as providerResolver
from app.lib import secrets
from app.services import configService
router = APIRouter(prefix='/api/config')

@router.get('/activeProvider')
async def activeProvider():
    """Get active provider and list all available providers.

    Only returns providers that have API keys configured —
    either built-in providers with keys in config.json/env vars,
    or custom providers from providers.json.
    """
    cfg = configService.getConfig()
    active = cfg.get('activeProvider')
    providers = []
    for p in providerResolver.listAvailable():
        apiKey = cfg.get(p['name'], {}).get('apiKey', '')
        if not apiKey:
            from app.providers.clients import getClient
            client = getClient(p)
            if client:
                apiKey = client.resolveApiKey() or ''
        if apiKey:
            providers.append({'id': p['name'], 'name': p['name'], 'apiMode': p.get('apiMode', ''), 'isAvailable': True, 'redactedKey': secrets.mask(apiKey)})
    store = configService.getProvidersStore()
    for entry in store.get('providers', []):
        name = entry.get('name', '')
        if not name or any((p['id'] == name for p in providers)):
            continue
        apiKey = entry.get('apiKey', '')
        if apiKey:
            providers.append({'id': name, 'name': name, 'apiMode': entry.get('apiFormat', 'openaiChat'), 'isAvailable': True, 'redactedKey': secrets.mask(apiKey)})
    return {'activeProvider': active, 'providers': providers}

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
    from app.services import aliasService
    return {'aliases': aliasService.listAliases()}

class ModelAliasesBulk(BaseModel):
    aliases: list[dict[str, object]]

@router.put('/model-aliases')
async def putModelAliases(body: ModelAliasesBulk):
    """Replace the entire alias list (validated)."""
    from app.services import aliasService
    try:
        return {'aliases': aliasService.replace_aliases(body.aliases, actor='ui')}
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(400, detail={'code': 'validation', 'message': str(exc)})

@router.get('/subagent-fallback')
async def getSubagentFallback():
    """Return the current sub-agent fallback configuration."""
    from app.services import fallbackService
    return fallbackService.getFallback()

class FallbackUpdate(BaseModel):
    enabled: bool | None = None
    mode: str | None = None
    provider: str | None = None
    model: str | None = None

@router.put('/subagent-fallback')
async def putSubagentFallback(body: FallbackUpdate):
    """Update sub-agent fallback fields (partial)."""
    from app.services import fallbackService
    try:
        return fallbackService.configureFallback(enabled=body.enabled, mode=body.mode, provider=body.provider, model=body.model, actor='ui')
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(400, detail={'code': 'validation', 'message': str(exc)})

class FallbackTest(BaseModel):
    model: str

@router.post('/subagent-fallback/test')
async def testSubagentFallback(body: FallbackTest):
    """Probe resolution of a model id without saving."""
    from app.services import fallbackService
    return fallbackService.test_fallback(body.model)

class BackgroundReviewUpdate(BaseModel):
    enabled: bool | None = None
    reviewModel: str | None = None
    reflectionModel: str | None = None
    autoMemoryModel: str | None = None

@router.get('/background-review')
async def getBackgroundReview():
    """Return the current background review config."""
    from app.services import backgroundReviewService
    return backgroundReviewService.getConfig()

@router.put('/background-review')
async def putBackgroundReview(body: BackgroundReviewUpdate):
    """Update background review config fields (partial)."""
    from app.services import backgroundReviewService
    return backgroundReviewService.saveConfig(enabled=body.enabled, review_model=body.reviewModel, reflection_model=body.reflectionModel, auto_memory_model=body.autoMemoryModel, actor='ui')

@router.get('/model-fleet')
async def getModelFleet():
    """v4.1: Return the merged fleet (defaults + user overrides) — see §10."""
    from app.services import modelFleetService
    return modelFleetService.getFleet()

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
    from app.services import modelFleetService
    ok, err, fleet = modelFleetService.update_fleet(body)
    if not ok:
        raise HTTPException(status_code=400, detail={'code': 'validation', 'message': err})
    return fleet

@router.get('/live')
async def getLiveConfig():
    """v4.2: Return the Live config (defaults + user overrides) — see §14.

    An empty `sttProvider`/`ttsProvider` means "use the browser default"
    (Web Speech API). Setting a provider upgrades to a paid service.
    """
    from app.services import liveConfigService
    return liveConfigService.getLiveConfig()

@router.put('/live')
async def putLiveConfig(body: dict[str, object]):
    """v4.2: Update Live config (partial).

    Body may contain any subset of {sttProvider, sttModel, ttsProvider,
    ttsModel, ttsVoice}. Each field is a string; empty values mean
    "browser default."
    """
    from fastapi import HTTPException
    from app.services import liveConfigService
    ok, err, cfg = liveConfigService.update_live_config(body)
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
    cfg = configService.getConfig()
    gw = cfg.get('gateway') or {}
    ea = gw.get('externalAccess') or {}
    enabled = bool(ea.get('enabled', False))
    apiKey = settings.gatewayApiKey
    return {'enabled': enabled, 'hasKey': bool(apiKey), 'keyPreview': secrets.mask(apiKey) if apiKey else None, 'source': 'env' if apiKey else None, 'endpoints': {'anthropic': f'http://localhost:{settings.port}/v1/messages', 'openai': f'http://localhost:{settings.port}/v1/chat/completions', 'models': f'http://localhost:{settings.port}/v1/models'}}

class ExternalAccessUpdate(BaseModel):
    enabled: bool

@router.put('/external-access')
async def putExternalAccess(body: ExternalAccessUpdate):
    """Toggle external API gateway access on/off.

    The ``GATEWAY_API_KEY`` itself is not part of this payload — it lives
    in ``.env`` (or system environment) and is managed outside the app.
    """
    if body.enabled and (not settings.gatewayApiKey):
        raise HTTPException(status_code=400, detail={'code': 'no_api_key', 'message': 'Cannot enable external access: GATEWAY_API_KEY is not configured. Set it in your .env file and restart the proxy.'})
    cfg = configService.getConfig()
    gw = cfg.setdefault('gateway', {})
    ea = gw.setdefault('externalAccess', {})
    ea['enabled'] = bool(body.enabled)
    configService.saveConfig(cfg)
    settings.reload()
    return {'enabled': ea['enabled'], 'hasKey': bool(settings.gatewayApiKey), 'keyPreview': secrets.mask(settings.gatewayApiKey) if settings.gatewayApiKey else None, 'source': 'env' if settings.gatewayApiKey else None}