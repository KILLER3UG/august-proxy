"""
Resolve a provider by name or model ID, with fallback logic.

Replaces the old ``builtin.py`` + ``registry.py`` approach with
``provider_templates.json`` (static templates) + ``providers.json``
(user-configured custom entries).

Port of backend/providers/provider-resolver.js + model-resolver.js (enhanced).
"""
from __future__ import annotations
from typing import Optional
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float
from app.config import settings
from app.providers import aliases
from app.providers.template_loader import getTemplates, getTemplate

def _templateToProviderDict(template: dict[str, object]) -> dict[str, object]:
    """Convert a template dict into a provider dict shaped like the old registry
    format so downstream consumers (model_resolver, route_resolver, workbench)
    continue to work unchanged.

    Key mappings (template → legacy field):
      displayName → display_name
      baseUrl     → base_url
      apiFormat   → api_mode
      authType    → auth_type
      defaultModel → default_model
      defaultMaxTokens → default_max_tokens
      signupUrl   → signup_url
      supportsHealthCheck → supports_health_check
      fallbackModels → fallback_models
      defaultHeaders → default_headers
      modelProfiles → model_profiles
    """
    return {'name': template.get('name', ''), 'id': template.get('id', ''), 'displayName': template.get('displayName', template.get('name', '')), 'description': template.get('description', ''), 'aliases': template.get('aliases', []), 'baseUrl': template.get('baseUrl', ''), 'apiMode': template.get('apiFormat', 'openaiChat'), 'envVars': template.get('envVars', []), 'authType': template.get('authType', 'api_key'), 'defaultModel': template.get('defaultModel', ''), 'defaultMaxTokens': template.get('defaultMaxTokens', 4096), 'defaultHeaders': template.get('defaultHeaders', {}), 'signupUrl': template.get('signupUrl', ''), 'supportsHealthCheck': template.get('supportsHealthCheck', False), 'fallbackModels': template.get('fallbackModels', []), 'modelProfiles': template.get('modelProfiles', {})}

def _customEntryToProviderDict(entry: dict[str, object]) -> dict[str, object]:
    """Build a provider dict from a ``providers.json`` custom entry.

    Merges template metadata (model_profiles, default_headers, env_vars)
    when a matching template id exists and the entry does not override it.
    """
    templateId = str(entry.get('template', '')) or str(entry.get('id', ''))
    tmpl = getTemplate(templateId) if templateId else None
    base = _templateToProviderDict(tmpl) if tmpl else {}
    base.update({'name': entry.get('name', base.get('name', '')), 'id': entry.get('id', base.get('id', '')), 'displayName': entry.get('displayName', entry.get('name', base.get('displayName', ''))), 'description': entry.get('description', base.get('description', '')), 'baseUrl': entry.get('baseUrl', base.get('baseUrl', '')), 'apiMode': entry.get('apiFormat', base.get('apiMode', 'openaiChat')), 'api_key': entry.get('apiKey', ''), 'is_custom': True, 'defaultModel': entry.get('defaultModel', base.get('defaultModel', '')), 'defaultMaxTokens': entry.get('defaultMaxTokens', base.get('defaultMaxTokens', 4096)), 'defaultHeaders': entry.get('defaultHeaders', base.get('defaultHeaders', {})), 'signupUrl': entry.get('signupUrl', base.get('signupUrl', '')), 'supportsHealthCheck': entry.get('supportsHealthCheck', base.get('supportsHealthCheck', False)), 'fallbackModels': entry.get('fallbackModels', base.get('fallbackModels', [])), 'modelProfiles': entry.get('modelProfiles', base.get('modelProfiles', {}))})
    return base

def _hasApiKey(provider: dict[str, object]) -> bool:
    """Check if a provider has credentials configured."""
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
    2. Template exact name match (via id or name)
    3. Template aliases list match
    4. Config.json modelAliases targetProvider
    5. Model profile key match (prefers provider with API key)
    6. Prefix-based name match (prefers provider with API key)
    7. Model profile key match (any provider)
    8. Prefix-based name match (any provider)
    """
    if not name:
        providers = listAvailable()
        return providers[0] if providers else None
    nameStr = str(name)
    from app.services import provider_credentials
    customEntry = provider_credentials._customEntry(nameStr)
    if customEntry and customEntry.get('enabled') and customEntry.get('apiKey'):
        return _customEntryToProviderDict(customEntry)
    canonical = aliases.normalize(nameStr)
    tmpl = getTemplate(canonical)
    if tmpl:
        return _templateToProviderDict(tmpl)
    allTemplates = getTemplates()
    allProviders = [_templateToProviderDict(t) for t in allTemplates]
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
        profiles = p.get('modelProfiles', {})
        if nameStr in profiles and _hasApiKey(p):
            return p
    for p in allProviders:
        pname = p['name'].lower().split()[0]
        if nameStr.lower().startswith(pname) and _hasApiKey(p):
            return p
    for p in allProviders:
        profiles = p.get('modelProfiles', {})
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
    """Return all available providers — templates + custom store entries."""
    templates = getTemplates()
    providers = [_templateToProviderDict(t) for t in templates]
    try:
        from app.services import config_service
        store = config_service.getProvidersStore()
    except Exception:
        store = {}
    for entry in store.get('providers', []):
        if entry.get('enabled') and entry.get('apiKey'):
            providers.append(_customEntryToProviderDict(entry))
    return providers
_hasApiKey = _hasApiKey