"""
Alias mapping service — consolidated, single-source-of-truth for proxy aliases.

What is an alias?
=================
In August Proxy, an *alias* is a **proxy mapping** — not just a nickname.
It lets the proxy expose a specified model name in ``/v1/models`` while
routing requests to a completely different provider + model upstream.

Example::

    A user who wants to use ``claude-sonnet`` in Claude Desktop but
    doesn't have a subscription configures an alias:

        alias: "claude-sonnet-4-6"
        targetProvider: "DeepSeek"
        targetModel: "deepseek-chat"

    When the backend runs:

    1. ``GET /v1/models`` returns ``claude-sonnet-4-6`` in the model list
       (alongside all provider models). See ``modelService._injectAliasModels()``.

    2. ``POST /v1/messages`` with ``model="claude-sonnet-4-6"`` is routed
       to DeepSeek with ``model="deepseek-chat"`` via ``resolve_alias()``.

    3. Response rewriting ensures the client sees the alias name,
       not the backend model ID.

Resolution order (documented here so developers don't need to hunt):
1. User-defined alias (``config.json modelAliases``) → targetProvider + targetModel
2. Built-in public alias (identity, e.g. ``claude-sonnet-4-6`` → itself)
3. Direct provider routing (``resolve_for_model`` credential-aware)
4. Fallback to active provider
"""

from __future__ import annotations

import logging

from app.config import settings
from app.json_narrowing import as_str
from app.models.aliases import AliasMapping, AliasResolutionResult
from app.providers import resolver as providerResolver
from app.providers.route_resolver import resolve_for_model

logger = logging.getLogger(__name__)

DEFAULT_ALIAS = 'default'

# Canonical Claude public model IDs — identity aliases that always work.
# This ensures clients using official Anthropic model names don't fail
# even without a user-defined alias.
BUILTIN_PUBLIC_ALIASES: frozenset[str] = frozenset(
    [
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
    ]
)


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
        aliases = settings.config.get('modelAliases', [])
        if isinstance(aliases, list):
            for entry in aliases:
                if not isinstance(entry, dict):
                    continue
                if entry.get('alias') == input_alias:
                    return AliasMapping(
                        alias=entry.get('alias', ''),
                        target_model=entry.get('targetModel') or entry.get('target_model', ''),
                        target_provider=entry.get('targetProvider') or entry.get('target_provider', ''),
                        display_alias=entry.get('displayAlias') or entry.get('display_alias', ''),
                    )
    except Exception:
        logger.exception('Failed to read modelAliases from config')
    return None


def _resolve_active_provider() -> dict[str, object] | None:
    """Return the first available provider with credentials."""
    for p in providerResolver.list_available():
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
       → uses ``targetProvider`` + ``targetModel`` from the alias
    2. Built-in public alias (identity, e.g. ``claude-sonnet-4-6`` → itself)
    3. Direct provider routing (``resolve_for_model`` credential-aware)
    4. Fallback to default alias or active provider

    Args:
        input_alias: The alias or model ID from the client request.
        provider_hint: Preferred provider name (used when multiple match).
        default_alias: Fallback alias if ``input_alias`` is None/empty.

    Returns:
        ``AliasResolutionResult`` with the resolved provider, model, and
        ``displayModel`` (the alias name presented to the client).

    Raises:
        ValueError: If no provider can be resolved.
    """
    normalized = _normalize(input_alias) or _normalize(default_alias) or DEFAULT_ALIAS

    # ── Step 1: User-defined alias ──────────────────────────────────────
    # The alias defines its OWN targetProvider + targetModel independently
    # of what the input string looks like. This is the core proxy-mapping
    # feature: "display claude-sonnet, route to deepseek-chat".
    userAlias = _find_user_alias(normalized)
    if userAlias is not None and userAlias.target_model:
        routed = resolve_for_model(
            userAlias.target_model,
            hint=userAlias.target_provider or provider_hint,
        )
        if routed is not None and _has_credentials(routed):
            display = userAlias.display_alias or userAlias.alias
            return AliasResolutionResult(
                alias=normalized,
                provider=userAlias.target_provider,
                model=userAlias.target_model,
                displayModel=display,
                isFallback=False,
                isDirect=False,
            )

            # ── Step 2: Built-in public alias (identity) ────────────────────────
            # Canonical Claude model IDs map to themselves. This ensures clients
            # using official model names work even without a user-defined alias.
    if normalized in BUILTIN_PUBLIC_ALIASES:
        routed = resolve_for_model(normalized, hint=provider_hint)
        if routed is not None and _has_credentials(routed):
            return AliasResolutionResult(
                alias=normalized,
                provider=as_str(routed.get('name'), 'unknown'),
                model=normalized,
                displayModel=normalized,
                isFallback=False,
                isDirect=False,
            )

            # ── Step 3: Direct provider routing ─────────────────────────────────
            # If the input looks like a raw model ID (not an alias), try to route
            # it directly to a provider that supports it.
    routed = resolve_for_model(normalized, hint=provider_hint)
    if routed is not None and _has_credentials(routed):
        return AliasResolutionResult(
            alias=normalized,
            provider=as_str(routed.get('name'), 'unknown'),
            model=normalized,
            displayModel=normalized,
            isFallback=False,
            isDirect=True,
        )

        # ── Step 4: Fallback to active provider ─────────────────────────────
    active = _resolve_active_provider()
    if active is not None and _has_credentials(active):
        model = active.get('defaultModel', normalized)
        provider_name = active.get('name', 'active')
        logger.warning(
            "Alias fallback: '%s' → active provider '%s' model '%s'",
            normalized,
            provider_name,
            model,
        )
        return AliasResolutionResult(
            alias=normalized,
            provider=as_str(provider_name, 'active'),
            model=as_str(model, normalized),
            displayModel=normalized,
            isFallback=True,
            isDirect=False,
        )

        # ── Nothing worked ──────────────────────────────────────────────────
    raise ValueError(
        f"Cannot resolve alias '{normalized}': no provider available with credentials. Check provider configuration."
    )


def resolve_alias_or_none(
    input_alias: str | None,
    provider_hint: str | None = None,
    default_alias: str | None = None,
) -> AliasResolutionResult | None:
    """Like ``resolve_alias`` but returns ``None`` instead of raising.

    Safe for use in streaming endpoints or background tasks where
    a resolution failure should not propagate as an exception.
    """
    try:
        return resolve_alias(input_alias, provider_hint=provider_hint, default_alias=default_alias)
    except ValueError:
        return None


def get_reverse_alias(backend_model_id: str) -> str | None:
    """Reverse lookup: given a backend model ID, find the alias that maps to it.

    Used for response rewriting — when the upstream returns a model ID,
    the proxy should present the alias name to the client instead.

    Args:
        backend_model_id: The raw model ID returned by the upstream provider.

    Returns:
        The alias name if found, or ``None``.
    """
    if not backend_model_id:
        return None
    try:
        aliases = settings.config.get('modelAliases', [])
        if isinstance(aliases, list):
            for entry in aliases:
                if not isinstance(entry, dict):
                    continue
                target = entry.get('targetModel') or entry.get('target_model')
                if target == backend_model_id:
                    return entry.get('alias')
    except Exception:
        pass
    if backend_model_id in BUILTIN_PUBLIC_ALIASES:
        return backend_model_id
    return None


def list_alias_names() -> list[str]:
    """Return every alias name the system knows about, deduplicated."""
    out: set[str] = set()
    try:
        aliases = settings.config.get('modelAliases', [])
        if isinstance(aliases, list):
            for entry in aliases:
                if isinstance(entry, dict) and entry.get('alias'):
                    out.add(entry['alias'])
    except Exception:
        pass
    out.update(BUILTIN_PUBLIC_ALIASES)
    return sorted(out)


def get_alias_models_for_v1_models() -> list[dict[str, object]]:
    """Return alias entries formatted for the ``/v1/models`` endpoint.

    Each alias is exposed as a model entry so that clients see the alias
    name alongside real provider models. The ``owned_by`` field is set to
    the alias's ``targetProvider`` so users can see where it routes.

    Returns:
        A list of dicts with keys ``id``, ``name``, ``provider``,
        ``contextWindow`` (default 128k), ``ownedBy``, ``isAlias``.
    """
    result: list[dict[str, object]] = []
    try:
        aliases = settings.config.get('modelAliases', [])
        if isinstance(aliases, list):
            for entry in aliases:
                if not isinstance(entry, dict):
                    continue
                aliasName = entry.get('alias', '')
                if not aliasName:
                    continue
                result.append(
                    {
                        'id': aliasName,
                        'name': entry.get('displayAlias') or aliasName,
                        'provider': entry.get('targetProvider', 'unknown'),
                        'contextWindow': 128000,
                        'ownedBy': entry.get('targetProvider', 'unknown'),
                        'isAlias': True,
                    }
                )
    except Exception:
        pass
        # Also expose built-in public aliases as identity entries
    for aliasName in BUILTIN_PUBLIC_ALIASES:
        if not any(r.get('id') == aliasName for r in result):
            result.append(
                {
                    'id': aliasName,
                    'name': aliasName,
                    'provider': 'builtin',
                    'contextWindow': 128000,
                    'ownedBy': 'builtin',
                    'isAlias': True,
                }
            )
    return result
