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
    # User-configured; no assumed default — unset until set in provider settings.
    context_window: int | None = None
    reasoning: bool = False
    free: bool = False
    source: str = 'manual'


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


class ModelUpdate(ExtraAllowBaseModel):
    """Request body for updating an existing model."""

    name: str | None = None
    context_window: int | None = None
    reasoning: bool | None = None
    free: bool | None = None
