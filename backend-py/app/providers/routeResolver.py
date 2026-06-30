"""
Route a model ID to the best provider.

Port of backend/providers/route-resolver.js + model-resolver.js.

Resolution order:
1. User-defined alias in config.json modelAliases → use targetProvider
2. Exact model match in provider's model_profiles (credential-aware)
3. Prefix match on provider name (credential-aware)
4. Model profile partial match (credential-aware)
5. Exact model match (any provider)
6. Prefix match (any provider)
7. Active provider (first with credentials)
"""
from __future__ import annotations
from typing import Any, Optional
from app.config import settings
from app.providers import registry, resolver

def _hasCredentials(provider: dict[str, Any]) -> bool:
    """Check if a provider has API credentials configured."""
    from app.providers.clients import getClient
    client = getClient(provider)
    if not client:
        return False
    return client.resolveApiKey() is not None

def resolveForModel(modelId: str, hint: Optional[str]=None) -> Optional[dict[str, Any]]:
    """
    Find the best provider for a model ID.

    Returns the first provider with credentials that supports the model.
    Falls through to credential-less providers only if no credentialled
    provider matches.
    """
    providers = resolver.listAvailable()
    if not providers:
        return None
    modelLower = modelId.lower()
    if hint:
        for p in providers:
            if p['name'].lower() == hint.lower():
                return p
            if hint.lower() in [a.lower() for a in p.get('aliases', [])]:
                return p
    aliases = settings.config.get('modelAliases', [])
    if isinstance(aliases, list):
        for aliasEntry in aliases:
            if aliasEntry.get('alias', '').lower() == modelLower:
                targetProvider = aliasEntry.get('targetProvider', '')
                if targetProvider:
                    for p in providers:
                        if p['name'].lower() == targetProvider.lower():
                            return p
                        if targetProvider.lower() in [a.lower() for a in p.get('aliases', [])]:
                            return p
    for p in providers:
        profiles = p.get('model_profiles', {})
        if (modelId in profiles or modelLower in {k.lower() for k in profiles}) and _hasCredentials(p):
            return p
    for p in providers:
        pname = p['name'].lower().split()[0]
        if modelLower.startswith(pname) and _hasCredentials(p):
            return p
    for p in providers:
        profiles = p.get('model_profiles', {})
        for profileKey in profiles:
            if profileKey != '*' and modelLower.startswith(profileKey.lower()) and _hasCredentials(p):
                return p
    for p in providers:
        for alias in p.get('aliases', []):
            if modelLower.startswith(alias.lower()) and _hasCredentials(p):
                return p
    for p in providers:
        profiles = p.get('model_profiles', {})
        if modelId in profiles or modelLower in {k.lower() for k in profiles}:
            return p
    for p in providers:
        pname = p['name'].lower().split()[0]
        if modelLower.startswith(pname):
            return p
    for p in providers:
        profiles = p.get('model_profiles', {})
        for profileKey in profiles:
            if profileKey != '*' and modelLower.startswith(profileKey.lower()):
                return p
    for p in providers:
        for alias in p.get('aliases', []):
            if modelLower.startswith(alias.lower()):
                return p
    return providers[0] if providers else None