"""
Resolve a provider by name or model ID, with fallback logic.

Replaces the old ``builtin.py`` + ``registry.py`` approach with
``provider_templates.json`` (static templates) + ``providers.json``
(user-configured custom entries).

Port of backend/providers/provider-resolver.js + model-resolver.js (enhanced).
"""
from __future__ import annotations
from typing import Optional
from app.config import settings
from app.providers import aliases
from app.providers.template_loader import get_templates, get_template

def _template_to_provider_dict(template: dict[str, object]) -> dict[str, object]:
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
    return {
        'name': template.get('name', ''),
        'id': template.get('id', ''),
        'display_name': template.get('displayName', template.get('name', '')),
        'description': template.get('description', ''),
        'aliases': template.get('aliases', []),
        'base_url': template.get('baseUrl', ''),
        'api_mode': template.get('apiFormat', 'openaiChat'),
        'env_vars': template.get('envVars', []),
        'auth_type': template.get('authType', 'api_key'),
        'default_model': template.get('defaultModel', ''),
        'default_max_tokens': template.get('defaultMaxTokens', 4096),
        'default_headers': template.get('defaultHeaders', {}),
        'signup_url': template.get('signupUrl', ''),
        'supports_health_check': template.get('supportsHealthCheck', False),
        'fallback_models': template.get('fallbackModels', []),
        'model_profiles': template.get('modelProfiles', {}),
    }


def _custom_entry_to_provider_dict(entry: dict[str, object]) -> dict[str, object]:
    """Build a provider dict from a ``providers.json`` custom entry.

    Merges template metadata (model_profiles, default_headers, env_vars)
    when a matching template id exists and the entry does not override it.
    """
    template_id = str(entry.get('template', '')) or str(entry.get('id', ''))
    tmpl = get_template(template_id) if template_id else None
    base = _template_to_provider_dict(tmpl) if tmpl else {}
    # Custom entry fields override template defaults
    base.update({
        'name': entry.get('name', base.get('name', '')),
        'id': entry.get('id', base.get('id', '')),
        'display_name': entry.get('display_name', entry.get('name', base.get('display_name', ''))),
        'description': entry.get('description', base.get('description', '')),
        'base_url': entry.get('baseUrl', base.get('base_url', '')),
        'api_mode': entry.get('apiFormat', base.get('api_mode', 'openaiChat')),
        'api_key': entry.get('apiKey', ''),
        'is_custom': True,
        'default_model': entry.get('default_model', base.get('default_model', '')),
        'default_max_tokens': entry.get('default_max_tokens', base.get('default_max_tokens', 4096)),
        'default_headers': entry.get('default_headers', base.get('default_headers', {})),
        'signup_url': entry.get('signup_url', base.get('signup_url', '')),
        'supports_health_check': entry.get('supports_health_check', base.get('supports_health_check', False)),
        'fallback_models': entry.get('fallback_models', base.get('fallback_models', [])),
        'model_profiles': entry.get('model_profiles', base.get('model_profiles', {})),
    })
    return base


def _has_api_key(provider: dict[str, object]) -> bool:
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

    name_str = str(name)

    # 0. Custom store entry
    from app.services import providerCredentials
    custom_entry = providerCredentials._customEntry(name_str)
    if custom_entry and custom_entry.get('enabled') and custom_entry.get('apiKey'):
        return _custom_entry_to_provider_dict(custom_entry)

    # 1. Normalize via aliases map
    canonical = aliases.normalize(name_str)

    # 2. Template exact match
    tmpl = get_template(canonical)
    if tmpl:
        return _template_to_provider_dict(tmpl)

    all_templates = get_templates()
    all_providers = [_template_to_provider_dict(t) for t in all_templates]

    for p in all_providers:
        if p['name'].lower() == name_str.lower():
            return p

    # 3. Template aliases match
    for p in all_providers:
        p_aliases = p.get('aliases', [])
        if isinstance(p_aliases, list):
            if name_str.lower() in [a.lower() for a in p_aliases]:
                return p

    # 4. Config modelAliases
    aliases_cfg = settings.config.get('modelAliases', [])
    if isinstance(aliases_cfg, list):
        for alias_entry in aliases_cfg:
            if alias_entry.get('alias', '').lower() == name_str.lower():
                target_provider = alias_entry.get('targetProvider', '')
                if target_provider:
                    for p in all_providers:
                        if p['name'].lower() == target_provider.lower():
                            return p
                        if target_provider.lower() in [a.lower() for a in p.get('aliases', [])]:
                            return p

    # 5. Model profile match (credential-aware)
    for p in all_providers:
        profiles = p.get('model_profiles', {})
        if name_str in profiles and _has_api_key(p):
            return p

    # 6. Prefix match (credential-aware)
    for p in all_providers:
        pname = p['name'].lower().split()[0]
        if name_str.lower().startswith(pname) and _has_api_key(p):
            return p

    # 7. Model profile match (any)
    for p in all_providers:
        profiles = p.get('model_profiles', {})
        if name_str in profiles:
            return p
        for profile_key in profiles:
            if profile_key != '*' and name_str.lower().startswith(profile_key.lower()):
                return p

    # 8. Prefix match (any)
    for p in all_providers:
        pname = p['name'].lower().split()[0]
        if name_str.lower().startswith(pname):
            return p

    return None


def listAvailable() -> list[dict[str, object]]:
    """Return all available providers — templates + custom store entries."""
    templates = get_templates()
    providers = [_template_to_provider_dict(t) for t in templates]

    # Merge custom store entries, skipping disabled or unkeyed ones
    try:
        from app.services import configService
        store = configService.getProvidersStore()
    except Exception:
        store = {}
    for entry in store.get('providers', []):
        if entry.get('enabled') and entry.get('apiKey'):
            providers.append(_custom_entry_to_provider_dict(entry))

    return providers


# Backward-compatible alias for the camelCase name (used by tests)
_hasApiKey = _has_api_key
