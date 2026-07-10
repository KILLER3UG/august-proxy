"""
Route a model ID to the best provider.

Port of backend/providers/route-resolver.js + model-resolver.js.

NOTE: Alias resolution is handled by ``app.services.aliasMappingService``
BEFORE this function is called. ``resolveForModel`` receives the already-
resolved backend model ID and finds a provider that can serve it.

Resolution order:
1. Exact model match in provider's model_profiles (credential-aware)
2. Prefix match on provider name (credential-aware)
3. Model profile partial match (credential-aware)
4. Exact model match (any provider)
5. Prefix match (any provider)
6. Active provider (first with credentials)
"""
from __future__ import annotations
from typing import Optional
from app.jsonUtils import as_dict, as_list
from app.providers import resolver

def _hasCredentials(provider: dict[str, object]) -> bool:
    """Check if a provider has API credentials configured."""
    from app.providers.clients import getClient
    client = getClient(provider)
    if not client:
        return False
    return client.resolveApiKey() is not None

def resolveForModel(modelId: str, hint: Optional[str]=None) -> Optional[dict[str, object]]:
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
            if hint.lower() in [a.lower() for a in as_list(p.get('aliases'), [])]:
                return p
    for p in providers:
        profiles = as_dict(p.get('model_profiles'), {})
        if (modelId in profiles or modelLower in {k.lower() for k in profiles}) and _hasCredentials(p):
            return p
    for p in providers:
        pname = p['name'].lower().split()[0]
        if modelLower.startswith(pname) and _hasCredentials(p):
            return p
    for p in providers:
        profiles = as_dict(p.get('model_profiles'), {})
        for profileKey in profiles:
            if profileKey != '*' and modelLower.startswith(profileKey.lower()) and _hasCredentials(p):
                return p
    for p in providers:
        for alias in as_list(p.get('aliases'), []):
            if modelLower.startswith(alias.lower()) and _hasCredentials(p):
                return p
    for p in providers:
        profiles = as_dict(p.get('model_profiles'), {})
        if modelId in profiles or modelLower in {k.lower() for k in profiles}:
            return p
    for p in providers:
        pname = p['name'].lower().split()[0]
        if modelLower.startswith(pname):
            return p
    for p in providers:
        profiles = as_dict(p.get('model_profiles'), {})
        for profileKey in profiles:
            if profileKey != '*' and modelLower.startswith(profileKey.lower()):
                return p
    for p in providers:
        for alias in as_list(p.get('aliases'), []):
            if modelLower.startswith(alias.lower()):
                return p
    return providers[0] if providers else None
