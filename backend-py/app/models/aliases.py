"""
Model alias types — Pydantic models for the alias proxy-mapping system.

An **alias** in August Proxy is a *proxy mapping*: it lets the proxy display
one model name in ``/v1/models`` (and accept it in requests) while routing to
a completely different provider + model combination upstream.

Example::

    Request:  model="claude-sonnet-4-6"
    Alias:    alias="claude-sonnet-4-6"
              → targetProvider="openai"
              → targetModel="gpt-4o"
    Upstream: POST /v1/chat/completions  { model: "gpt-4o" }
    Response: model="claude-sonnet-4-6"  (client sees the alias, not gpt-4o)

This is NOT simply a "nickname" — it is a full provider+model indirection.
The client sees the alias name throughout the API; the backend model ID is
never leaked to the client unless explicitly configured.
"""
from __future__ import annotations

from app.models.base import ExtraAllowBaseModel


class AliasMapping(ExtraAllowBaseModel):
    """A single alias-to-backend mapping.

    Fields:
        alias: The public-facing model name clients use in requests.
        target_model: The actual backend model ID routed to upstream.
        target_provider: The provider name that serves the target model.
        display_alias: Optional friendlier name shown in the UI dropdown
            (defaults to ``alias`` if empty).
    """
    alias: str
    target_model: str
    target_provider: str
    display_alias: str = ""


class AliasResolutionResult(ExtraAllowBaseModel):
    """The result of resolving an alias.

    This tells the caller what provider+model to actually call, and what
    model name to present back to the client.

    Fields:
        alias: The original alias that was resolved.
        provider: The resolved provider name (from ``target_provider``).
        model: The resolved backend model ID (from ``target_model``).
        display_model: The model name to show the client (usually the alias).
        is_fallback: Whether this was a fallback (no matching alias found).
        is_direct: Whether this was a direct model ID (not an alias at all).
    """
    alias: str
    provider: str
    model: str
    display_model: str = ""
    is_fallback: bool = False
    is_direct: bool = False
