"""Provider configuration Pydantic models.

Covers the ProviderConfig / ModelConfig shapes used by the provider
CRUD endpoints and the config service.
"""

from __future__ import annotations

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


class ProviderCreate(ExtraAllowBaseModel):
    """Request body for creating a new provider (user-configured only)."""

    name: str
    base_url: str = ''
    api_format: str = 'openaiChat'
    api_key: str = ''
    enabled: bool = True


class ProviderUpdate(ExtraAllowBaseModel):
    """Request body for updating an existing provider."""

    name: str | None = None
    base_url: str | None = None
    api_format: str | None = None
    api_key: str | None = None
    enabled: bool | None = None


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
