"""Provider credentials — single source of truth consulting providers.json + built-in registry."""
from __future__ import annotations

import json
import os

import pytest


@pytest.fixture
def fake_providers_store(tmp_path, monkeypatch):
    """Inject a fake providers.json store and force the helper to reload it."""
    from app.services import config_service, provider_credentials

    path = tmp_path / "providers.json"
    path.write_text(json.dumps({
        "providers": [
            {
                "id": "custom-minimax-abc123",
                "name": "MiniMax (Global)",
                "baseUrl": "https://api.custom.example/anthropic",
                "apiFormat": "anthropic_messages",
                "apiKey": "sk-custom-key-12345",
                "enabled": True,
            },
            {
                "id": "openai-xyz",
                "name": "OpenAI",
                "baseUrl": "",
                "apiFormat": "openai-chat",
                "apiKey": "sk-openai-67890",
                "enabled": True,
            },
        ]
    }), encoding="utf-8")
    # Redirect data_path so config_service picks up our fake store
    monkeypatch.setattr(config_service, "data_path", lambda name, *a, **kw: path if name == "providers.json" else path)
    # Force the helper to reload via the public API
    provider_credentials.invalidate()
    yield path
    provider_credentials.invalidate()
    # Restore env var
    os.environ.pop("MINIMAX_API_KEY", None)


def test_custom_store_entry_resolves_to_provider_with_api_key(fake_providers_store):
    from app.services import provider_credentials

    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    assert creds["api_key"] == "sk-custom-key-12345"
    assert creds["provider"]["name"] == "MiniMax (Global)"


def test_custom_store_entry_resolves_by_id(fake_providers_store):
    from app.services import provider_credentials

    creds = provider_credentials.resolve("custom-minimax-abc123")
    assert creds is not None
    assert creds["api_key"] == "sk-custom-key-12345"


def test_unknown_provider_returns_none(fake_providers_store):
    from app.services import provider_credentials

    creds = provider_credentials.resolve("Nonexistent Provider XYZ")
    assert creds is None


def test_built_in_registry_fallback_when_custom_store_empty(tmp_path, monkeypatch):
    """With empty providers.json, built-in MiniMax resolves via env_key."""
    from app.services import config_service, provider_credentials

    # Empty store
    path = tmp_path / "providers.json"
    path.write_text(json.dumps({"providers": []}), encoding="utf-8")
    monkeypatch.setattr(config_service, "data_path", lambda name, *a, **kw: path if name == "providers.json" else path)
    provider_credentials.invalidate()
    monkeypatch.setenv("MINIMAX_API_KEY", "sk-from-env")

    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    # Built-in client returns env value
    assert creds["api_key"] == "sk-from-env"
    provider_credentials.invalidate()


def test_resolve_empty_string_returns_none():
    """``resolve("")`` short-circuits to ``None`` without touching the store."""
    from app.services import provider_credentials

    assert provider_credentials.resolve("") is None
    assert provider_credentials.resolve("   ") is None  # whitespace-only is also empty-ish


def test_resolve_disabled_provider_falls_back_to_registry(tmp_path, monkeypatch):
    """A custom-store entry whose ``enabled`` is False is skipped — resolve()
    falls through to the built-in registry path instead. This matches the
    behavior in ``model_service._aggregate_models`` and prevents disabled
    custom providers from masquerading as available."""
    from app.services import config_service, provider_credentials

    path = tmp_path / "providers.json"
    path.write_text(json.dumps({
        "providers": [
            {
                "id": "custom-minimax-abc123",
                "name": "MiniMax (Global)",
                "baseUrl": "https://api.custom.example/anthropic",
                "apiFormat": "anthropic_messages",
                "apiKey": "sk-custom-key-12345",
                "enabled": False,  # explicitly disabled
            },
        ]
    }), encoding="utf-8")
    monkeypatch.setattr(config_service, "data_path", lambda name, *a, **kw: path if name == "providers.json" else path)
    provider_credentials.invalidate()
    monkeypatch.setenv("MINIMAX_API_KEY", "sk-from-env")

    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    # Should be the registry path, NOT the custom-store entry
    assert creds["source"] == "registry"
    assert creds["api_key"] == "sk-from-env"
    provider_credentials.invalidate()


def test_resolve_empty_api_key_falls_back_to_registry(tmp_path, monkeypatch):
    """A custom-store entry with an empty ``apiKey`` is also skipped — only
    entries that are both enabled AND keyed should win over the registry."""
    from app.services import config_service, provider_credentials

    path = tmp_path / "providers.json"
    path.write_text(json.dumps({
        "providers": [
            {
                "id": "custom-minimax-abc123",
                "name": "MiniMax (Global)",
                "baseUrl": "https://api.custom.example/anthropic",
                "apiFormat": "anthropic_messages",
                "apiKey": "",
                "enabled": True,
            },
        ]
    }), encoding="utf-8")
    monkeypatch.setattr(config_service, "data_path", lambda name, *a, **kw: path if name == "providers.json" else path)
    provider_credentials.invalidate()
    monkeypatch.setenv("MINIMAX_API_KEY", "sk-from-env")

    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    assert creds["source"] == "registry"
    assert creds["api_key"] == "sk-from-env"
    provider_credentials.invalidate()


def test_resolve_is_case_insensitive(fake_providers_store):
    """Custom-store lookup is case-insensitive (mirrors ``provider_resolver.resolve``).

    All of the following should resolve to the same custom-store entry:
      - exact name ``"MiniMax (Global)"``
      - upper-case name ``"MINIMAX (GLOBAL)"``
      - mixed-case id ``"Custom-MiniMax-ABC123"``
    """
    from app.services import provider_credentials

    exact = provider_credentials.resolve("MiniMax (Global)")
    upper = provider_credentials.resolve("MINIMAX (GLOBAL)")
    mixed_id = provider_credentials.resolve("Custom-MiniMax-ABC123")

    assert exact is not None
    assert upper is not None
    assert mixed_id is not None

    # Same custom-store source and api key, regardless of casing
    assert exact["source"] == "custom_store"
    assert upper["source"] == "custom_store"
    assert mixed_id["source"] == "custom_store"
    assert exact["api_key"] == "sk-custom-key-12345"
    assert upper["api_key"] == "sk-custom-key-12345"
    assert mixed_id["api_key"] == "sk-custom-key-12345"


def test_invalidate_clears_cache(fake_providers_store):
    """The public ``invalidate()`` API drops the in-memory cache so subsequent
    ``resolve()`` calls reload from disk. This is the contract
    ``config_service.save_providers_store`` relies on to keep the helper
    in sync with on-disk writes."""
    from app.services import provider_credentials

    # Trigger a load by resolving something that hits the custom store.
    provider_credentials.resolve("MiniMax (Global)")
    assert provider_credentials._store_cache is not None

    # The public invalidation API should drop the cache.
    provider_credentials.invalidate()
    assert provider_credentials._store_cache is None

    # And the helper should reload cleanly afterwards.
    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    assert creds["source"] == "custom_store"
