"""Provider credentials — single source of truth consulting providers.json + built-in registry."""
from __future__ import annotations

import pytest


@pytest.fixture
def fake_providers_store(tmp_path, monkeypatch):
    """Inject a fake providers.json store and force the helper to reload it."""
    import json
    import os
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
    # Force the helper to reload
    provider_credentials._store_cache = None
    yield path
    provider_credentials._store_cache = None
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
    import json
    import os
    from app.services import config_service, provider_credentials

    # Empty store
    path = tmp_path / "providers.json"
    path.write_text(json.dumps({"providers": []}), encoding="utf-8")
    monkeypatch.setattr(config_service, "data_path", lambda name, *a, **kw: path if name == "providers.json" else path)
    provider_credentials._store_cache = None
    monkeypatch.setenv("MINIMAX_API_KEY", "sk-from-env")

    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    # Built-in client returns env value
    assert creds["api_key"] == "sk-from-env"
    provider_credentials._store_cache = None
