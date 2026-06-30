"""
Centralized alias-first model resolution.

Port of backend/providers/model-resolver.js.

Single source of truth for "given an alias or a raw model id, return
``{ alias, provider, model, is_fallback }``".

Resolution order:
1. User-defined alias in config.json modelAliases
2. Catalog display alias (from model_profiles)
3. Direct provider routing (profile key match + credential check)
4. Raise ModelResolutionError

``resolve_or_fallback`` wraps ``resolve`` and falls back to the
active provider's model on any miss.
"""
from __future__ import annotations
import logging
from typing import Any, Optional
from app.config import settings
from app.providers import registry, resolver as providerResolver
from app.providers.routeResolver import resolveForModel
logger = logging.getLogger(__name__)
DEFAULT_ALIAS = 'default'
BUILTIN_CLAUDE_PUBLIC_ALIASES = frozenset(['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'])

class ModelResolutionError(Exception):
    """Raised when a model alias cannot be resolved."""

    def __init__(self, message: str, input: str | None=None, reason: str | None=None) -> None:
        super().__init__(message)
        self.input = input
        self.reason = reason

def _normalize(input: Any) -> str | None:
    """Normalize input to a trimmed string or None."""
    if input is None:
        return None
    s = str(input).strip()
    return s or None

def _findUserDefinedAlias(input: str) -> dict[str, Any] | None:
    """Find a user-defined alias in config.json modelAliases."""
    if not input:
        return None
    try:
        aliases = settings.config.get('modelAliases', [])
        if isinstance(aliases, list):
            for a in aliases:
                if isinstance(a, dict) and a.get('alias') == input:
                    return a
    except Exception:
        pass
    return None

def _hasCredentials(provider: dict[str, Any]) -> bool:
    """Check if a provider has API credentials configured."""
    from app.providers.clients import getClient
    client = getClient(provider)
    if not client:
        return False
    return client.resolve_api_key() is not None

def resolve(input: str | None, providerHint: str | None=None, defaultAlias: str | None=None) -> dict[str, Any]:
    """Resolve an alias or model ID to a ``{ alias, provider, model, is_fallback }`` tuple.

    Args:
        input: The alias or raw model ID to resolve.
        provider_hint: Preferred provider name when multiple match.
        default_alias: Default alias to use when input is falsy.

    Returns:
        Resolution result dict with keys ``alias``, ``provider``, ``model``, ``is_fallback``.

    Raises:
        ModelResolutionError: If the input cannot be resolved.
    """
    normalized = _normalize(input) or _normalize(defaultAlias) or DEFAULT_ALIAS
    userAlias = _findUserDefinedAlias(normalized)
    if userAlias and userAlias.get('targetModel'):
        routed = resolveForModel(userAlias['targetModel'], hint=userAlias.get('targetProvider') or providerHint)
        if routed and _hasCredentials(routed):
            return {'alias': normalized, 'provider': routed.get('name', userAlias.get('targetProvider', 'unknown')), 'model': userAlias['targetModel'], 'is_fallback': False}
    allProviders = providerResolver.list_available()
    for p in allProviders:
        profiles = p.get('model_profiles', {})
        if normalized in profiles:
            break
    routed = resolveForModel(normalized, hint=providerHint)
    if routed and _hasCredentials(routed):
        return {'alias': normalized, 'provider': routed.get('name', 'unknown'), 'model': normalized, 'is_fallback': False}
    raise ModelResolutionError(f"Alias '{normalized}' not found.", input=normalized, reason='no_matching_provider')

def resolveOrFallback(input: str | None, providerHint: str | None=None, defaultAlias: str | None=None) -> dict[str, Any] | None:
    """Resolve with graceful fallback to the active provider. Never raises.

    Args:
        input: The alias or raw model ID to resolve.
        provider_hint: Preferred provider name when multiple match.
        default_alias: Default alias to use when input is falsy.

    Returns:
        Resolution result dict, or ``None`` if no provider is available.
    """
    originalInput = _normalize(input)
    normalized = originalInput or _normalize(defaultAlias) or DEFAULT_ALIAS
    try:
        result = resolve(normalized, provider_hint=providerHint)
        if result:
            return result
    except ModelResolutionError:
        pass
    except Exception as exc:
        logger.warning(f"[ModelResolver] unexpected error resolving '{normalized}': {exc}")
    active = _resolveActiveProvider()
    if active and _hasCredentials(active):
        model = active.get('default_model', normalized)
        providerName = active.get('name', 'active')
        logger.warning(f"[ModelResolver] falling back to active provider '{providerName}' for input '{normalized}'")
        return {'alias': originalInput or normalized, 'provider': providerName, 'model': model, 'is_fallback': True}
    logger.warning(f"[ModelResolver] no active provider available; cannot resolve '{normalized}'")
    return None

def _resolveActiveProvider() -> dict[str, Any] | None:
    """Get the currently active provider (first available with credentials)."""
    for p in providerResolver.list_available():
        if _hasCredentials(p):
            return p
    return None

def getAliasForModel(modelId: str) -> str | None:
    """Reverse lookup: given a raw model ID, find the alias that maps to it."""
    if not modelId:
        return None
    try:
        aliases = settings.config.get('modelAliases', [])
        if isinstance(aliases, list):
            for a in aliases:
                if isinstance(a, dict) and a.get('targetModel') == modelId:
                    return a.get('alias')
    except Exception:
        pass
    if modelId in BUILTIN_CLAUDE_PUBLIC_ALIASES:
        return modelId
    return None

def listAliases() -> list[str]:
    """Return every alias the system knows about, deduplicated."""
    out: set[str] = set()
    try:
        aliases = settings.config.get('modelAliases', [])
        if isinstance(aliases, list):
            for a in aliases:
                if isinstance(a, dict) and a.get('alias'):
                    out.add(a['alias'])
    except Exception:
        pass
    for a in BUILTIN_CLAUDE_PUBLIC_ALIASES:
        out.add(a)
    return sorted(out)

def getDefaultAlias() -> str:
    return DEFAULT_ALIAS