"""
Alias mapping service — consolidated, single-source-of-truth for proxy aliases.

What is an alias?
=================
In August Proxy, an *alias* is a **proxy mapping** — not just a nickname.
It lets the proxy display one model name (the alias) to the client while
routing to a completely different provider + model combination upstream.

This is the core of August's "model abstraction" feature. Without aliases,
``/v1/models`` leaks real provider model IDs to the client. With aliases,
the client sees only the model names you choose, and the proxy handles
the routing behind the scenes.

Key behaviors
=============
1. When a client sends ``model="claude-sonnet-4-6"``, the proxy checks
   aliases FIRST. If it matches, the alias's ``target_provider`` and
   ``target_model`` determine where the request actually goes.

2. The response model name is set to the *alias*, not the backend model.
   This keeps the backend provider opaque to the client.

3. If no alias matches, the resolution falls through to direct model
   routing (``resolveForModel``). This preserves backward compatibility
   for clients that send raw provider model IDs.

Resolution order
=================
1. User-defined alias (config.json ``modelAliases``) → exact match
2. Built-in public aliases (``claude-*-*`` canonical IDs) → identity alias
3. Direct provider routing (profile key match + credential check)
4. Fallback to active provider

Usage::

    from app.services.aliasMappingService import resolveAlias

    result = resolveAlias("claude-sonnet-4-6")
    # → AliasResolutionResult(
    #     alias="claude-sonnet-4-6",
    #     provider="openai",
    #     model="gpt-4o",
    #     display_model="claude-sonnet-4-6",
    #     is_fallback=False,
    #     is_direct=False,
    #   )
"""
from __future__ import annotations

import logging
from typing import Optional

from app.config import settings
from app.models.aliases import AliasMapping, AliasResolutionResult
from app.providers import resolver as providerResolver
from app.providers.routeResolver import resolveForModel

logger = logging.getLogger(__name__)

DEFAULT_ALIAS = "default"

# Canonical Claude public model IDs that should always be recognized.
# These are identity aliases — they map to themselves — so that clients
# using canonical Anthropic model IDs don't fail when no alias is defined.
BUILTIN_PUBLIC_ALIASES: frozenset[str] = frozenset([
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
])


# ── Internal helpers ────────────────────────────────────────────────────

def _normalize(value: object) -> str | None:
    """Trim and return a string, or None if falsy."""
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _has_credentials(provider: dict[str, object]) -> bool:
    """Check if a provider has API credentials configured."""
    from app.providers.clients import getClient
    client = getClient(provider)
    if client is None:
        return False
    return client.resolveApiKey() is not None


def _find_user_alias(input_alias: str) -> AliasMapping | None:
    """Look up a user-defined alias from ``config.json modelAliases``.

    Returns an ``AliasMapping`` if found, or ``None``.
    """
    if not input_alias:
        return None
    try:
        aliases = settings.config.get("modelAliases", [])
        if isinstance(aliases, list):
            for entry in aliases:
                if not isinstance(entry, dict):
                    continue
                if entry.get("alias") == input_alias:
                    return AliasMapping(
                        alias=entry.get("alias", ""),
                        target_model=entry.get("targetModel") or entry.get("target_model", ""),
                        target_provider=entry.get("targetProvider") or entry.get("target_provider", ""),
                        display_alias=entry.get("displayAlias") or entry.get("display_alias", ""),
                    )
    except Exception:
        logger.exception("Failed to read modelAliases from config")
    return None


def _resolve_active_provider() -> dict[str, object] | None:
    """Return the first available provider with credentials."""
    for p in providerResolver.listAvailable():
        if _has_credentials(p):
            return p
    return None


# ── Public API ──────────────────────────────────────────────────────────

def resolve_alias(
    input_alias: str | None,
    provider_hint: str | None = None,
    default_alias: str | None = None,
) -> AliasResolutionResult:
    """Resolve a model alias to a concrete provider + model.

    This is the single entry point for all alias resolution in the proxy.
    Every adapter, router, or service that needs to turn a client-supplied
    model name into a backend provider+model should call this function.

    Resolution order:
    1. User-defined alias (``config.json modelAliases``) — exact match
    2. Built-in public alias (identity match, e.g. ``claude-sonnet-4-6``)
    3. Direct provider routing (``resolveForModel`` credential-aware)
    4. Fallback to default alias or active provider

    Args:
        input_alias: The alias or model ID from the client request.
        provider_hint: Preferred provider name (used when multiple match).
        default_alias: Fallback alias if ``input_alias`` is None/empty.

    Returns:
        ``AliasResolutionResult`` with the resolved provider, model, and
        display model (the alias name presented to the client).

    Raises:
        ValueError: If no provider can be resolved (no config, no creds).
    """
    normalized = _normalize(input_alias) or _normalize(default_alias) or DEFAULT_ALIAS

    # ── Step 1: User-defined alias ──────────────────────────────────────
    user_alias = _find_user_alias(normalized)
    if user_alias is not None and user_alias.target_model:
        # Resolve the target provider using the alias's target_model.
        # This ensures the provider has credentials and is available.
        routed = resolveForModel(
            user_alias.target_model,
            hint=user_alias.target_provider or provider_hint,
        )
        if routed is not None and _has_credentials(routed):
            display = user_alias.display_alias or user_alias.alias
            return AliasResolutionResult(
                alias=normalized,
                provider=user_alias.target_provider,
                model=user_alias.target_model,
                display_model=display,
                is_fallback=False,
                is_direct=False,
            )

    # ── Step 2: Built-in public alias (identity) ────────────────────────
    # These map a canonical Claude model ID to itself. This ensures that
    # clients using official Anthropic model names get routed to a provider
    # that handles that model, even without a user-defined alias.
    if normalized in BUILTIN_PUBLIC_ALIASES:
        routed = resolveForModel(normalized, hint=provider_hint)
        if routed is not None and _has_credentials(routed):
            return AliasResolutionResult(
                alias=normalized,
                provider=routed.get("name", "unknown"),
                model=normalized,
                display_model=normalized,
                is_fallback=False,
                is_direct=False,
            )

    # ── Step 3: Direct provider routing ─────────────────────────────────
    # If the input looks like a raw model ID (not an alias), try to route
    # it directly to a provider that supports it.
    routed = resolveForModel(normalized, hint=provider_hint)
    if routed is not None and _has_credentials(routed):
        return AliasResolutionResult(
            alias=normalized,
            provider=routed.get("name", "unknown"),
            model=normalized,
            display_model=normalized,
            is_fallback=False,
            is_direct=True,
        )

    # ── Step 4: Fallback to active provider ─────────────────────────────
    active = _resolve_active_provider()
    if active is not None and _has_credentials(active):
        model = active.get("defaultModel", normalized)
        provider_name = active.get("name", "active")
        logger.warning(
            "Alias fallback: '%s' → active provider '%s' model '%s'",
            normalized, provider_name, model,
        )
        return AliasResolutionResult(
            alias=normalized,
            provider=provider_name,
            model=model,
            display_model=normalized,
            is_fallback=True,
            is_direct=False,
        )

    # ── Nothing worked ──────────────────────────────────────────────────
    raise ValueError(
        f"Cannot resolve alias '{normalized}': no provider available "
        f"with credentials. Check provider configuration."
    )


def resolve_alias_or_none(
    input_alias: str | None,
    provider_hint: str | None = None,
    default_alias: str | None = None,
) -> AliasResolutionResult | None:
    """Like ``resolve_alias`` but returns ``None`` instead of raising.

    Safe for use in contexts where a resolution failure should not
    propagate as an exception (e.g. streaming endpoints, background tasks).
    """
    try:
        return resolve_alias(input_alias, provider_hint=provider_hint, default_alias=default_alias)
    except ValueError:
        return None


def get_reverse_alias(backend_model_id: str) -> str | None:
    """Reverse lookup: given a backend model ID, find the alias that maps to it.

    This is used for response rewriting — when the upstream returns a model
    ID, the proxy should present the alias name to the client instead.

    Args:
        backend_model_id: The raw model ID returned by the upstream provider.

    Returns:
        The alias name if found, or ``None``.
    """
    if not backend_model_id:
        return None
    try:
        aliases = settings.config.get("modelAliases", [])
        if isinstance(aliases, list):
            for entry in aliases:
                if not isinstance(entry, dict):
                    continue
                target = entry.get("targetModel") or entry.get("target_model")
                if target == backend_model_id:
                    return entry.get("alias")
    except Exception:
        pass
    if backend_model_id in BUILTIN_PUBLIC_ALIASES:
        return backend_model_id
    return None


def list_alias_names() -> list[str]:
    """Return every alias name the system knows about, deduplicated."""
    out: set[str] = set()
    try:
        aliases = settings.config.get("modelAliases", [])
        if isinstance(aliases, list):
            for entry in aliases:
                if isinstance(entry, dict) and entry.get("alias"):
                    out.add(entry["alias"])
    except Exception:
        pass
    out.update(BUILTIN_PUBLIC_ALIASES)
    return sorted(out)
