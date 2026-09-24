"""Provider configuration Pydantic models.

Covers the ProviderConfig / ModelConfig shapes used by the provider
CRUD endpoints and the config service.
"""

from __future__ import annotations

from typing import Literal

from app.models.base import ExtraAllowBaseModel


class ModelConfig(ExtraAllowBaseModel):
    """A single model entry within a provider configuration."""

    id: str
    name: str = ''
    # Default 128k; users can override in Model Providers.
    context_window: int = 128000
    reasoning: bool = False
    free: bool = False
    pinned: bool = False
    source: str = 'manual'
    # Optional per-model wire-format override. None → provider apiFormat.
    # Needed for multi-format gateways (e.g. OpenCode Zen) that list Claude,
    # GPT, and DeepSeek models from one /models endpoint.
    api_format: str | None = None
    # Per-model reasoning_effort override. None → use heuristic.
    # True = always send reasoning_effort; False = never send it.
    supports_reasoning_effort: bool | None = None
    # Cap the mapped reasoning_effort value (e.g. 'medium' means max→medium).
    # None → no cap (max maps to 'high' as usual).
    max_reasoning_effort: str | None = None
    # Per-model capability profile (harness adaptation). None → tool defaults.
    # tool_surface: 'full' (default) | 'reduced' (drop heavy tools) | 'bare'
    # (read/write/run_command/state only). max_tools caps the number of tool
    # definitions shown (0 = no cap). max_tool_result_chars caps per-result
    # truncation (0 = harness default).
    tool_surface: str | None = None
    max_tools: int = 0
    max_tool_result_chars: int = 0
    # Reference-modal fields: output cap + modality support badges. All
    # optional; absent/None = unspecified (heuristic defaults apply).
    max_output_tokens: int | None = None
    input_types: list[str] | None = None
    output_types: list[str] | None = None
    # Per-model price in USD per 1M tokens. None = unknown, which lets the
    # cost estimator fall back to its family table; 0.0 is a real price
    # ("this host bills nothing"), so the two must not collapse together.
    # Set alongside `free` in Model settings — see cost_estimator for the
    # precedence the two resolve to.
    price_in_per_m: float | None = None
    price_out_per_m: float | None = None


class QuotaExtractConfig(ExtraAllowBaseModel):
    """Dotted JSON paths into a declared quota endpoint's response.

    Each path names where the provider states one value. An absent or
    unresolved path means "not stated" — never zero — so a provider that
    publishes no cap leaves the row on its local estimate.
    """

    model: str = ''
    limit: str = ''
    remaining: str = ''
    used: str = ''
    reset: str = ''


class QuotaEndpointConfig(ExtraAllowBaseModel):
    """Opt-in, user-declared provider quota endpoint.

    August contacts this only when a user configures it. ``url`` is either an
    absolute URL (used exactly as written) or a path joined onto the provider's
    baseUrl under the same exact-base rule as chat — no invented ``/v1``.
    """

    # Only JSON is supported; adding a kind means adding a real parser for it.
    kind: Literal['json'] = 'json'
    url: str = ''
    method: Literal['GET', 'POST'] = 'GET'
    headers: dict[str, str] = {}
    body: dict[str, object] | None = None
    # Optional model id for an account-level endpoint that reports one
    # aggregate budget rather than per-model rows.
    model: str = ''
    bucket: str = ''
    extract: QuotaExtractConfig = QuotaExtractConfig()


class QuotaAuthConfig(ExtraAllowBaseModel):
    """How to authenticate the declared quota endpoint.

    ``use_provider_key`` (the default) reuses the provider's stored API key so
    the secret is never written twice; ``token`` is for endpoints whose
    credential differs from the chat key.
    """

    type: Literal['none', 'bearer', 'header', 'query'] = 'none'
    header: str = ''
    prefix: str = ''
    param: str = ''
    token: str = ''
    use_provider_key: bool = True


class ProviderConfig(ExtraAllowBaseModel):
    """A provider entry from the providers config store.

    Maps to the ProviderConfigDict TypedDict in type_aliases.
    """

    id: str = ''
    name: str = ''
    api_format: str = 'openaiChat'
    api_key: str = ''
    base_url: str = ''
    enabled: bool = True
    auto_fetch: bool = False
    models: list[ModelConfig] = []
    # Absent = August never contacts a quota endpoint for this provider.
    quota_endpoint: QuotaEndpointConfig | None = None
    quota_auth: QuotaAuthConfig | None = None


class ProviderCreate(ExtraAllowBaseModel):
    """Request body for creating a new provider (user-configured only)."""

    name: str
    base_url: str = ''
    api_format: str = 'openaiChat'
    api_key: str = ''
    enabled: bool = True
    quota_endpoint: QuotaEndpointConfig | None = None
    quota_auth: QuotaAuthConfig | None = None


class ProviderUpdate(ExtraAllowBaseModel):
    """Request body for updating an existing provider."""

    name: str | None = None
    base_url: str | None = None
    api_format: str | None = None
    api_key: str | None = None
    enabled: bool | None = None
    # Set to an object to declare/change the quota endpoint; null clears it
    # (the provider goes back to headers + local usage only).
    quota_endpoint: QuotaEndpointConfig | None = None
    quota_auth: QuotaAuthConfig | None = None
    auto_fetch: bool | None = None


class ModelCreate(ExtraAllowBaseModel):
    """Request body for creating a new model."""

    id: str
    name: str | None = None
    context_window: int | None = None
    reasoning: bool | None = None
    free: bool | None = None
    pinned: bool | None = None
    api_format: str | None = None
    supports_reasoning_effort: bool | None = None
    max_reasoning_effort: str | None = None
    # Reference-modal fields: output cap + modality support badges.
    max_output_tokens: int | None = None
    input_types: list[str] | None = None
    output_types: list[str] | None = None
    price_in_per_m: float | None = None
    price_out_per_m: float | None = None


class ModelUpdate(ExtraAllowBaseModel):
    """Request body for updating an existing model."""

    name: str | None = None
    context_window: int | None = None
    reasoning: bool | None = None
    free: bool | None = None
    pinned: bool | None = None
    api_format: str | None = None
    supports_reasoning_effort: bool | None = None
    max_reasoning_effort: str | None = None
    tool_surface: str | None = None
    max_tools: int | None = None
    max_tool_result_chars: int | None = None
    # Reference-modal fields: output cap + modality support badges.
    max_output_tokens: int | None = None
    input_types: list[str] | None = None
    output_types: list[str] | None = None
    # Price override. Sending null for both clears the override and returns the
    # model to the family table; 0.0 is kept as a real zero price.
    price_in_per_m: float | None = None
    price_out_per_m: float | None = None
