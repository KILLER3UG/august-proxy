"""
Model alias types — Pydantic models for the alias proxy-mapping system.

What is an alias?
=================
An **alias** in August Proxy is a *proxy mapping*: it lets the proxy expose
a specified model name in ``/v1/models`` (and accept it in requests) while
routing to a completely different provider + model combination upstream.

Example::

    A user who wants to use ``claude-sonnet`` in Claude Desktop but
    doesn't have a subscription configures an alias:

        alias:          "claude-sonnet-4-6"
        targetProvider: "DeepSeek"
        targetModel:    "deepseek-chat"

    When the backend runs:

    1. ``GET /v1/models`` returns ``claude-sonnet-4-6`` in the model list
       (alongside all provider models).

    2. ``POST /v1/messages`` with ``model="claude-sonnet-4-6"`` is routed
       to DeepSeek with ``model="deepseek-chat"``.

    3. The response rewrite ensures the client sees the alias name
       (``claude-sonnet-4-6``) not the backend model ID.

This is NOT simply a "nickname" — it is a full provider+model indirection
that makes the proxy completely transparent to the client.

Resolution order (see aliasMappingService.py):
1. User-defined alias (config.json ``modelAliases``) → targetProvider + targetModel
2. Built-in public alias (identity, e.g. ``claude-sonnet-4-6`` → itself)
3. Direct provider routing (``resolve_for_model`` credential-aware)
4. Fallback to active provider
"""

from __future__ import annotations

from app.models.base import ExtraAllowBaseModel


class AliasMapping(ExtraAllowBaseModel):
    """A single alias-to-backend mapping.

    Fields:
        alias: The public-facing model name clients use in requests.
            e.g. ``"claude-sonnet-4-6"``
        targetModel: The actual backend model ID routed to upstream.
            e.g. ``"deepseek-chat"``
        targetProvider: The provider name that serves the target model.
            e.g. ``"DeepSeek"``
        displayAlias: Optional friendlier name shown in UI dropdown.
            Defaults to ``alias`` if empty.
    """

    alias: str
    target_model: str
    target_provider: str
    display_alias: str = ''


class AliasResolutionResult(ExtraAllowBaseModel):
    """The result of resolving an alias.

    This tells the caller what provider+model to actually call, and what
    model name to present back to the client.

    Fields:
        alias: The original alias that was resolved.
        provider: The resolved provider name (from ``targetProvider``).
        model: The resolved backend model ID (from ``targetModel``).
        displayModel: The model name to show the client (usually the alias).
        isFallback: Whether this was a fallback (no matching alias found).
        isDirect: Whether this was a direct model ID (not an alias at all).
    """

    alias: str
    provider: str
    model: str
    displayModel: str = ''
    isFallback: bool = False
    isDirect: bool = False
