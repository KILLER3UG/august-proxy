"""
Resolve a provider by name or model ID from **user-configured** providers only.

Source of truth: ``data/providers.json`` (via config_service). There is no
built-in template catalog — users define name, base URL, API format, and key.
"""

from __future__ import annotations

from typing import Optional

from app.config import settings
from app.json_narrowing import as_list, as_str
from app.providers import aliases


def entry_to_provider_dict(entry: dict[str, object]) -> dict[str, object]:
    """Build a provider dict from a ``providers.json`` entry."""
    from app.providers.api_format import normalize_api_format

    return {
        'name': entry.get('name', ''),
        'id': entry.get('id', ''),
        'displayName': entry.get('displayName', entry.get('name', '')),
        'description': entry.get('description', ''),
        'aliases': entry.get('aliases', []),
        'baseUrl': entry.get('baseUrl', ''),
        'apiMode': normalize_api_format(entry.get('apiFormat') or entry.get('apiMode'), default='openaiChat'),
        'api_key': entry.get('apiKey', ''),
        'is_custom': True,
        'envVars': entry.get('envVars', []),
        'authType': entry.get('authType', 'api_key'),
        'defaultModel': entry.get('defaultModel', ''),
        'defaultMaxTokens': entry.get('defaultMaxTokens', 4096),
        'defaultHeaders': entry.get('defaultHeaders', {}),
        'signupUrl': entry.get('signupUrl', ''),
        'supportsHealthCheck': entry.get('supportsHealthCheck', False),
        'fallbackModels': entry.get('fallbackModels', []),
        'modelProfiles': entry.get('modelProfiles', {}),
        'enabled': bool(entry.get('enabled', True)),
        'models': entry.get('models', []),
    }


# Back-compat for older call sites
_customEntryToProviderDict = entry_to_provider_dict


def _iter_store_entries() -> list[dict[str, object]]:
    try:
        from app.services import config_service

        store = config_service.getProvidersStore()
    except Exception:
        return []
    out: list[dict[str, object]] = []
    for raw in as_list(store.get('providers'), []):
        if isinstance(raw, dict):
            out.append(raw)
    return out


def _hasApiKey(provider: dict[str, object]) -> bool:
    if provider.get('api_key') or provider.get('apiKey'):
        return True
    from app.providers.clients import getClient

    client = getClient(provider)
    if not client:
        return False
    return client.resolveApiKey() is not None


def resolve(name: str) -> Optional[dict[str, object]]:
    """Find a configured provider by id, name, alias, or model-alias target."""
    if not name:
        providers = list_available()
        return providers[0] if providers else None

    name_str = str(name)
    name_l = name_str.lower()
    entries = _iter_store_entries()

    def _match_entry(target: str) -> Optional[dict[str, object]]:
        t = target.lower()
        id_hit: Optional[dict[str, object]] = None
        name_hit: Optional[dict[str, object]] = None
        for e in entries:
            if not e.get('enabled', True):
                continue
            if as_str(e.get('id')).lower() == t and id_hit is None:
                id_hit = e
            if as_str(e.get('name')).lower() == t and name_hit is None:
                name_hit = e
        hit = id_hit or name_hit
        return entry_to_provider_dict(hit) if hit else None

    hit = _match_entry(name_str)
    if hit:
        return hit

    canonical = aliases.normalize(name_str)
    if canonical != name_str:
        hit = _match_entry(canonical)
        if hit:
            return hit

    for e in entries:
        if not e.get('enabled', True):
            continue
        for a in as_list(e.get('aliases'), []):
            if as_str(a).lower() == name_l:
                return entry_to_provider_dict(e)

    aliases_cfg = settings.config.get('modelAliases', [])
    if isinstance(aliases_cfg, list):
        for alias_entry in aliases_cfg:
            if not isinstance(alias_entry, dict):
                continue
            if as_str(alias_entry.get('alias')).lower() == name_l:
                target = as_str(alias_entry.get('targetProvider'))
                if target:
                    hit = _match_entry(target)
                    if hit:
                        return hit

    keyed: list[dict[str, object]] = []
    any_match: list[dict[str, object]] = []
    for e in entries:
        if not e.get('enabled', True):
            continue
        p = entry_to_provider_dict(e)
        models = as_list(e.get('models'), [])
        model_ids = {as_str(m.get('id') if isinstance(m, dict) else m).lower() for m in models}
        if name_l in model_ids:
            if _hasApiKey(p):
                keyed.append(p)
            else:
                any_match.append(p)
    if keyed:
        return keyed[0]
    if any_match:
        return any_match[0]
    return None


def list_available() -> list[dict[str, object]]:
    """Enabled providers from providers.json that have an API key."""
    out: list[dict[str, object]] = []
    for e in _iter_store_entries():
        if not e.get('enabled', True):
            continue
        if not e.get('apiKey'):
            continue
        out.append(entry_to_provider_dict(e))
    return out


def list_all_configured() -> list[dict[str, object]]:
    """All enabled providers (with or without key)."""
    out: list[dict[str, object]] = []
    for e in _iter_store_entries():
        if not e.get('enabled', True):
            continue
        out.append(entry_to_provider_dict(e))
    return out


_hasApiKey = _hasApiKey
