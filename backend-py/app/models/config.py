"""Provider configuration Pydantic models.

Covers the ProviderConfig / ModelConfig shapes used by the provider
CRUD endpoints and the config service.
"""
from __future__ import annotations

from app.models.base import ExtraAllowBaseModel, JsonValue


class ModelConfig(ExtraAllowBaseModel):
    """A single model entry within a provider configuration."""
    id: str
    name: str = ""
    contextWindow: int = 128000
    reasoning: bool = False
    free: bool = False
    source: str = "manual"


class ProviderConfig(ExtraAllowBaseModel):
    """A provider entry from the providers config store.

    Maps to the ProviderConfigDict TypedDict in typeAliases.
    """
    id: str = ""
    name: str = ""
    apiFormat: str = "openaiChat"
    apiKey: str = ""
    baseUrl: str = ""
    enabled: bool = True
    autoFetch: bool = False
    models: list[ModelConfig] = []
