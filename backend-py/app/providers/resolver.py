"""
Resolve a provider by name or model ID, with fallback logic.

Port of backend/providers/provider-resolver.js + model-resolver.js (enhanced).
"""
from __future__ import annotations
from typing import Optional
from app.config import settings
from app.providers import registry, aliases
from app.providers.builtin import registerAll

def _hasApiKey(provider: dict[str, object]) -> bool:
    """Check if a provider has credentials configured (custom store or built-in env)."""
    if provider.get('is_custom'):
        return bool(provider.get('api_key'))
    from app.providers.clients import getClient
    client = getClient(provider)
    if not client:
        return False
    return client.resolveApiKey() is not None

def resolve(name: str) -> Optional[dict[str, object]]:
    """Find a provider by name, alias, or model ID.

    Resolution order:
    0. Custom ``providers.json`` store (authoritative for user-added providers)
    1. Normalize via aliases map
    2. Exact name match
    3. Provider aliases list match
    4. Config.json modelAliases targetProvider
    5. Model profile key match (prefers provider with API key)
    6. Prefix-based name match (prefers provider with API key)
    7. Model profile key match (any provider)
    8. Prefix-based name match (any provider)
    """
    if not registry.names():
        registerAll()
    if not name:
        providers = listAvailable()
        return providers[0] if providers else None
    nameStr = str(name)
    from app.services import providerCredentials
    customEntry = providerCredentials._customEntry(nameStr)
    if customEntry and customEntry.get('enabled') and customEntry.get('apiKey'):
        return providerCredentials._custom_provider_dict(customEntry)
    canonical = aliases.normalize(nameStr)
    provider = registry.get(canonical)
    if provider:
        return provider
    allProviders = registry.listAll()
    for p in allProviders:
        if p['name'].lower() == nameStr.lower():
            return p
    for p in allProviders:
        pAliases = p.get('aliases', [])
        if isinstance(pAliases, list):
            if nameStr.lower() in [a.lower() for a in pAliases]:
                return p
    aliasesCfg = settings.config.get('modelAliases', [])
    if isinstance(aliasesCfg, list):
        for aliasEntry in aliasesCfg:
            if aliasEntry.get('alias', '').lower() == nameStr.lower():
                targetProvider = aliasEntry.get('targetProvider', '')
                if targetProvider:
                    for p in allProviders:
                        if p['name'].lower() == targetProvider.lower():
                            return p
                        if targetProvider.lower() in [a.lower() for a in p.get('aliases', [])]:
                            return p
    for p in allProviders:
        profiles = p.get('model_profiles', {})
        if nameStr in profiles and _hasApiKey(p):
            return p
    for p in allProviders:
        pname = p['name'].lower().split()[0]
        if nameStr.lower().startswith(pname) and _hasApiKey(p):
            return p
    for p in allProviders:
        profiles = p.get('model_profiles', {})
        if nameStr in profiles:
            return p
        for profileKey in profiles:
            if profileKey != '*' and nameStr.lower().startswith(profileKey.lower()):
                return p
    for p in allProviders:
        pname = p['name'].lower().split()[0]
        if nameStr.lower().startswith(pname):
            return p
    return None

def listAvailable() -> list[dict[str, object]]:
    """Return all registered providers."""
    if not registry.names():
        registerAll()
    return registry.listAll()