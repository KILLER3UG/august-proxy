"""Provider credentials — single source of truth consulting providers.json + built-in registry."""
from __future__ import annotations
import json
import os
import pytest

@pytest.fixture
def fakeProvidersStore(tmp_path, monkeypatch):
    """Inject a fake providers.json store and force the helper to reload it."""
    from app.services import configService, providerCredentials
    path = tmp_path / 'providers.json'
    path.write_text(json.dumps({'providers': [{'id': 'custom-minimax-abc123', 'name': 'MiniMax (Global)', 'baseUrl': 'https://api.custom.example/anthropic', 'apiFormat': 'anthropic_messages', 'apiKey': 'sk-custom-key-12345', 'enabled': True}, {'id': 'openai-xyz', 'name': 'OpenAI', 'baseUrl': '', 'apiFormat': 'openai-chat', 'apiKey': 'sk-openai-67890', 'enabled': True}]}), encoding='utf-8')
    monkeypatch.setattr(configService, 'data_path', lambda name, *a, **kw: path if name == 'providers.json' else path)
    providerCredentials.invalidate()
    yield path
    providerCredentials.invalidate()
    os.environ.pop('MINIMAX_API_KEY', None)

def testCustomStoreEntryResolvesToProviderWithApiKey(fakeProvidersStore):
    from app.services import providerCredentials
    creds = providerCredentials.resolve('MiniMax (Global)')
    assert creds is not None
    assert creds['api_key'] == 'sk-custom-key-12345'
    assert creds['provider']['name'] == 'MiniMax (Global)'

def testCustomStoreEntryResolvesById(fakeProvidersStore):
    from app.services import providerCredentials
    creds = providerCredentials.resolve('custom-minimax-abc123')
    assert creds is not None
    assert creds['api_key'] == 'sk-custom-key-12345'

def testUnknownProviderReturnsNone(fakeProvidersStore):
    from app.services import providerCredentials
    creds = providerCredentials.resolve('Nonexistent Provider XYZ')
    assert creds is None

def testBuiltInRegistryFallbackWhenCustomStoreEmpty(tmp_path, monkeypatch):
    """With empty providers.json, built-in MiniMax resolves via env_key."""
    from app.services import configService, providerCredentials
    path = tmp_path / 'providers.json'
    path.write_text(json.dumps({'providers': []}), encoding='utf-8')
    monkeypatch.setattr(configService, 'data_path', lambda name, *a, **kw: path if name == 'providers.json' else path)
    providerCredentials.invalidate()
    monkeypatch.setenv('MINIMAX_API_KEY', 'sk-from-env')
    creds = providerCredentials.resolve('MiniMax (Global)')
    assert creds is not None
    assert creds['api_key'] == 'sk-from-env'
    providerCredentials.invalidate()

def testResolveEmptyStringReturnsNone():
    """``resolve("")`` short-circuits to ``None`` without touching the store."""
    from app.services import providerCredentials
    assert providerCredentials.resolve('') is None
    assert providerCredentials.resolve('   ') is None

def testResolveDisabledProviderFallsBackToRegistry(tmp_path, monkeypatch):
    """A custom-store entry whose ``enabled`` is False is skipped — resolve()
    falls through to the built-in registry path instead. This matches the
    behavior in ``model_service._aggregate_models`` and prevents disabled
    custom providers from masquerading as available."""
    from app.services import configService, providerCredentials
    path = tmp_path / 'providers.json'
    path.write_text(json.dumps({'providers': [{'id': 'custom-minimax-abc123', 'name': 'MiniMax (Global)', 'baseUrl': 'https://api.custom.example/anthropic', 'apiFormat': 'anthropic_messages', 'apiKey': 'sk-custom-key-12345', 'enabled': False}]}), encoding='utf-8')
    monkeypatch.setattr(configService, 'data_path', lambda name, *a, **kw: path if name == 'providers.json' else path)
    providerCredentials.invalidate()
    monkeypatch.setenv('MINIMAX_API_KEY', 'sk-from-env')
    creds = providerCredentials.resolve('MiniMax (Global)')
    assert creds is not None
    assert creds['source'] == 'registry'
    assert creds['api_key'] == 'sk-from-env'
    providerCredentials.invalidate()

def testResolveEmptyApiKeyFallsBackToRegistry(tmp_path, monkeypatch):
    """A custom-store entry with an empty ``apiKey`` is also skipped — only
    entries that are both enabled AND keyed should win over the registry."""
    from app.services import configService, providerCredentials
    path = tmp_path / 'providers.json'
    path.write_text(json.dumps({'providers': [{'id': 'custom-minimax-abc123', 'name': 'MiniMax (Global)', 'baseUrl': 'https://api.custom.example/anthropic', 'apiFormat': 'anthropic_messages', 'apiKey': '', 'enabled': True}]}), encoding='utf-8')
    monkeypatch.setattr(configService, 'data_path', lambda name, *a, **kw: path if name == 'providers.json' else path)
    providerCredentials.invalidate()
    monkeypatch.setenv('MINIMAX_API_KEY', 'sk-from-env')
    creds = providerCredentials.resolve('MiniMax (Global)')
    assert creds is not None
    assert creds['source'] == 'registry'
    assert creds['api_key'] == 'sk-from-env'
    providerCredentials.invalidate()

def testResolveIsCaseInsensitive(fakeProvidersStore):
    """Custom-store lookup is case-insensitive (mirrors ``provider_resolver.resolve``).

    All of the following should resolve to the same custom-store entry:
      - exact name ``"MiniMax (Global)"``
      - upper-case name ``"MINIMAX (GLOBAL)"``
      - mixed-case id ``"Custom-MiniMax-ABC123"``
    """
    from app.services import providerCredentials
    exact = providerCredentials.resolve('MiniMax (Global)')
    upper = providerCredentials.resolve('MINIMAX (GLOBAL)')
    mixedId = providerCredentials.resolve('Custom-MiniMax-ABC123')
    assert exact is not None
    assert upper is not None
    assert mixedId is not None
    assert exact['source'] == 'custom_store'
    assert upper['source'] == 'custom_store'
    assert mixedId['source'] == 'custom_store'
    assert exact['api_key'] == 'sk-custom-key-12345'
    assert upper['api_key'] == 'sk-custom-key-12345'
    assert mixedId['api_key'] == 'sk-custom-key-12345'

def testInvalidateClearsCache(fakeProvidersStore):
    """The public ``invalidate()`` API drops the in-memory cache so subsequent
    ``resolve()`` calls reload from disk. This is the contract
    ``config_service.save_providers_store`` relies on to keep the helper
    in sync with on-disk writes."""
    from app.services import providerCredentials
    providerCredentials.resolve('MiniMax (Global)')
    assert providerCredentials._store_cache is not None
    providerCredentials.invalidate()
    assert providerCredentials._store_cache is None
    creds = providerCredentials.resolve('MiniMax (Global)')
    assert creds is not None
    assert creds['source'] == 'custom_store'

def testResolverFindsCustomStoreEntry(fakeProvidersStore):
    from app.providers import resolver as providerResolver
    provider = providerResolver.resolve('MiniMax (Global)')
    assert provider is not None
    assert provider.get('is_custom') is True
    assert provider['api_key'] == 'sk-custom-key-12345'

def testResolverHasApiKeyUsesCustomStore(fakeProvidersStore):
    from app.providers import resolver as providerResolver
    provider = providerResolver.resolve('MiniMax (Global)')
    assert providerResolver._has_api_key(provider) is True

def testWorkbenchCredentialCheckUsesCustomStore(fakeProvidersStore):
    """Given a custom-store MiniMax with a key, the workbench credential check passes."""
    from app.providers import resolver as providerResolver
    from app.services import providerCredentials
    provider = providerResolver.resolve('MiniMax (Global)')
    assert provider is not None
    creds = providerCredentials.resolve('MiniMax (Global)')
    assert creds is not None
    assert creds['api_key'] == 'sk-custom-key-12345'
    apiKey = (creds or {}).get('api_key') if creds else None
    assert apiKey