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
from app.providers import registry, resolver as provider_resolver
from app.providers.route_resolver import resolve_for_model

logger = logging.getLogger(__name__)

DEFAULT_ALIAS = "default"

BUILTIN_CLAUDE_PUBLIC_ALIASES = frozenset([
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
])


class ModelResolutionError(Exception):
    """Raised when a model alias cannot be resolved."""

    def __init__(self, message: str, input: str | None = None, reason: str | None = None) -> None:
        super().__init__(message)
        self.input = input
        self.reason = reason


def _normalize(input: Any) -> str | None:
    """Normalize input to a trimmed string or None."""
    if input is None:
        return None
    s = str(input).strip()
    return s or None


def _find_user_defined_alias(input: str) -> dict[str, Any] | None:
    """Find a user-defined alias in config.json modelAliases."""
    if not input:
        return None
    try:
        aliases = settings.config.get("modelAliases", [])
        if isinstance(aliases, list):
            for a in aliases:
                if isinstance(a, dict) and a.get("alias") == input:
                    return a
    except Exception:
        pass
    return None


def _has_credentials(provider: dict[str, Any]) -> bool:
    """Check if a provider has API credentials configured."""
    from app.providers.clients import get_client

    client = get_client(provider)
    if not client:
        return False
    return client.resolve_api_key() is not None


def resolve(
    input: str | None,
    provider_hint: str | None = None,
    default_alias: str | None = None,
) -> dict[str, Any]:
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
    normalized = _normalize(input) or _normalize(default_alias) or DEFAULT_ALIAS

    # 1. User-defined alias from config.json modelAliases
    user_alias = _find_user_defined_alias(normalized)
    if user_alias and user_alias.get("targetModel"):
        routed = resolve_for_model(
            user_alias["targetModel"],
            hint=user_alias.get("targetProvider") or provider_hint,
        )
        if routed and _has_credentials(routed):
            return {
                "alias": normalized,
                "provider": routed.get("name", user_alias.get("targetProvider", "unknown")),
                "model": user_alias["targetModel"],
                "is_fallback": False,
            }

    # 2. Catalog display alias from model_profiles
    # Check if the normalized input matches any provider's profile key
    # and that provider has a different canonical model ID
    all_providers = provider_resolver.list_available()
    for p in all_providers:
        profiles = p.get("model_profiles", {})
        if normalized in profiles:
            # Found a matching profile key — this IS the model ID
            # (No display alias mapping without a live /models fetch)
            break

    # 3. Direct provider routing
    routed = resolve_for_model(normalized, hint=provider_hint)
    if routed and _has_credentials(routed):
        return {
            "alias": normalized,
            "provider": routed.get("name", "unknown"),
            "model": normalized,
            "is_fallback": False,
        }

    # 4. Nothing matched
    raise ModelResolutionError(
        f"Alias '{normalized}' not found.",
        input=normalized,
        reason="no_matching_provider",
    )


def resolve_or_fallback(
    input: str | None,
    provider_hint: str | None = None,
    default_alias: str | None = None,
) -> dict[str, Any] | None:
    """Resolve with graceful fallback to the active provider. Never raises.

    Args:
        input: The alias or raw model ID to resolve.
        provider_hint: Preferred provider name when multiple match.
        default_alias: Default alias to use when input is falsy.

    Returns:
        Resolution result dict, or ``None`` if no provider is available.
    """
    original_input = _normalize(input)
    normalized = original_input or _normalize(default_alias) or DEFAULT_ALIAS

    try:
        result = resolve(normalized, provider_hint=provider_hint)
        if result:
            return result
    except ModelResolutionError:
        pass
    except Exception as exc:
        logger.warning(f"[ModelResolver] unexpected error resolving '{normalized}': {exc}")

    # Fall back to active provider
    active = _resolve_active_provider()
    if active and _has_credentials(active):
        model = active.get("default_model", normalized)
        provider_name = active.get("name", "active")
        logger.warning(f"[ModelResolver] falling back to active provider '{provider_name}' for input '{normalized}'")
        return {
            "alias": original_input or normalized,
            "provider": provider_name,
            "model": model,
            "is_fallback": True,
        }

    logger.warning(f"[ModelResolver] no active provider available; cannot resolve '{normalized}'")
    return None


def _resolve_active_provider() -> dict[str, Any] | None:
    """Get the currently active provider (first available with credentials)."""
    for p in provider_resolver.list_available():
        if _has_credentials(p):
            return p
    return None


def get_alias_for_model(model_id: str) -> str | None:
    """Reverse lookup: given a raw model ID, find the alias that maps to it."""
    if not model_id:
        return None

    # 1. User-defined aliases whose targetModel matches
    try:
        aliases = settings.config.get("modelAliases", [])
        if isinstance(aliases, list):
            for a in aliases:
                if isinstance(a, dict) and a.get("targetModel") == model_id:
                    return a.get("alias")
    except Exception:
        pass

    # 2. Built-in Claude aliases
    if model_id in BUILTIN_CLAUDE_PUBLIC_ALIASES:
        return model_id

    return None


def list_aliases() -> list[str]:
    """Return every alias the system knows about, deduplicated."""
    out: set[str] = set()

    # User-defined aliases
    try:
        aliases = settings.config.get("modelAliases", [])
        if isinstance(aliases, list):
            for a in aliases:
                if isinstance(a, dict) and a.get("alias"):
                    out.add(a["alias"])
    except Exception:
        pass

    # Built-in Claude aliases
    for a in BUILTIN_CLAUDE_PUBLIC_ALIASES:
        out.add(a)

    return sorted(out)


def get_default_alias() -> str:
    return DEFAULT_ALIAS
