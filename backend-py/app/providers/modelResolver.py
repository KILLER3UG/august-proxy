"""
Centralized alias-first model resolution.

Port of backend/providers/model-resolver.js.

Single source of truth for "given an alias or a raw model id, return
``{ alias, provider, model, is_fallback }``".

Resolution is delegated to ``app.services.aliasMappingService``, which
is the single point of truth for all alias resolution. This module
provides backward-compatible wrappers so existing callers don't break.

Resolution order (from aliasMappingService):
1. User-defined alias in config.json modelAliases → targetProvider + targetModel
2. Built-in public alias (identity, e.g. ``claude-sonnet-4-6`` → itself)
3. Direct provider routing (profile key match + credential check)
4. Fallback to active provider

``resolve_or_fallback`` wraps ``resolve`` and falls back to the
active provider's model on any miss.
"""
from __future__ import annotations
import logging
from app.config import settings
from app.providers import resolver as providerResolver
from app.providers.routeResolver import resolveForModel
from app.services.alias_mapping_service import (
    resolveAlias,
    resolveAliasOrNone,
    getReverseAlias as _getReverseAlias,
    listAliasNames,
    BUILTIN_PUBLIC_ALIASES,
)
logger = logging.getLogger(__name__)
DEFAULT_ALIAS = 'default'
# Re-export for backward compatibility
BUILTIN_CLAUDE_PUBLIC_ALIASES = BUILTIN_PUBLIC_ALIASES

class ModelResolutionError(Exception):
    """Raised when a model alias cannot be resolved."""

    def __init__(self, message: str, input: str | None=None, reason: str | None=None) -> None:
        super().__init__(message)
        self.input = input
        self.reason = reason

def _normalize(input: object) -> str | None:
    """Normalize input to a trimmed string or None."""
    if input is None:
        return None
    s = str(input).strip()
    return s or None

def _hasCredentials(provider: dict[str, object]) -> bool:
    """Check if a provider has API credentials configured."""
    from app.providers.clients import getClient
    client = getClient(provider)
    if not client:
        return False
    return client.resolveApiKey() is not None

def resolve(input: str | None, providerHint: str | None=None, defaultAlias: str | None=None) -> dict[str, object]:
    """Resolve an alias or model ID to a ``{ alias, provider, model, is_fallback }`` tuple.

    Delegates to ``aliasMappingService.resolve_alias()`` which provides the
    centralized, documented alias-resolution pipeline. Backward-compatible
    return format preserved for existing callers.

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
    try:
        result = resolveAlias(normalized, providerHint=providerHint)
        return {
            'alias': result.alias,
            'provider': result.provider,
            'model': result.model,
            'is_fallback': result.isFallback,
        }
    except ValueError as exc:
        raise ModelResolutionError(str(exc), input=normalized, reason='no_matching_provider') from exc

def resolveOrFallback(input: str | None, providerHint: str | None=None, defaultAlias: str | None=None) -> dict[str, object] | None:
    """Resolve with graceful fallback to the active provider. Never raises.

    Delegates to ``aliasMappingService.resolve_alias_or_none()``.

    Args:
        input: The alias or raw model ID to resolve.
        provider_hint: Preferred provider name when multiple match.
        default_alias: Default alias to use when input is falsy.

    Returns:
        Resolution result dict, or ``None`` if no provider is available.
    """
    originalInput = _normalize(input)
    normalized = originalInput or _normalize(defaultAlias) or DEFAULT_ALIAS
    result = resolveAliasOrNone(normalized, providerHint=providerHint)
    if result is not None:
        return {
            'alias': result.alias,
            'provider': result.provider,
            'model': result.model,
            'is_fallback': result.isFallback,
        }
    logger.warning(f"[ModelResolver] no active provider available; cannot resolve '{normalized}'")
    return None

def getAliasForModel(modelId: str) -> str | None:
    """Reverse lookup: given a raw model ID, find the alias that maps to it."""
    return _getReverseAlias(modelId)

def listAliases() -> list[str]:
    """Return every alias the system knows about, deduplicated."""
    return listAliasNames()

def getDefaultAlias() -> str:
    return DEFAULT_ALIAS