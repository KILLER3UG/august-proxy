"""
Provider setup tool — lets the model configure a model provider hands-free.

The intended flow (driven by the model inside the chat loop):

1. The model uses ``web_search`` / ``web_fetch`` to find the provider's base
   URL and API format.
2. The model suggests a friendly name (and asks the user to confirm or rename
   it) and calls ``setup_provider`` *without* an API key. The provider is
   created (or updated) with everything except the key.
3. The chat UI renders an inline field where the user pastes their key. On
   submit the frontend PATCHes ``/api/providers/{id}`` with the key, finishing
   the configuration. (The model can also call ``setup_provider`` again with
   ``providerId`` + ``apiKey`` if the user pastes the key into the chat.)

This keeps the secret out of the model's reasoning text: the key is only ever
written by the UI / a direct follow-up call, never echoed back in the tool
result beyond a boolean ``needsApiKey`` flag.
"""
from __future__ import annotations
import hashlib
import json
import time
from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float

# Canonical API formats understood by the proxy. Kept in sync with the
# provider templates (openaiChat / anthropicMessages) plus the OpenAI
# Responses variant.
_VALID_FORMATS = frozenset({'openaiChat', 'anthropicMessages', 'openaiResponses'})

_FORMAT_ALIASES = {
    'openai': 'openaiChat',
    'openai-chat': 'openaiChat',
    'openai_chat': 'openaiChat',
    'chat': 'openaiChat',
    'anthropic': 'anthropicMessages',
    'anthropic-messages': 'anthropicMessages',
    'anthropic_messages': 'anthropicMessages',
    'messages': 'anthropicMessages',
    'openai-responses': 'openaiResponses',
    'openai_responses': 'openaiResponses',
    'responses': 'openaiResponses',
}


def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


def _normalize_format(api_format: str | None) -> str:
    if not api_format:
        return 'openaiChat'
    norm = _FORMAT_ALIASES.get(str(api_format).lower(), str(api_format))
    return norm if norm in _VALID_FORMATS else 'openaiChat'


async def setupProvider(
    name: str = '',
    baseUrl: str = '',
    apiFormat: str = 'openaiChat',
    suggestedName: str = '',
    apiKey: str = '',
    providerId: str = '',
) -> str:
    """Create or update a model provider, leaving the API key for the user.

    Args:
        name: Display name for a new provider (e.g. "DeepSeek").
        baseUrl: Base URL for the provider's API (e.g. "https://api.deepseek.com").
        apiFormat: API format — one of openaiChat | anthropicMessages |
            openaiResponses (common aliases accepted).
        suggestedName: Optional name the model recommends; surfaced to the user
            so they can confirm or rename.
        apiKey: Optional. Usually omitted on the first call; supply it only if
            the user has already pasted the key into the chat.
        providerId: Optional id of an existing provider to update instead of
            creating a new one.
    """
    if not name and not providerId:
        return _err("A 'name' (for a new provider) or an existing 'providerId' is required.")

    api_format = _normalize_format(apiFormat)

    from app.services import config_service, model_service
    from app.providers.template_loader import getTemplates

    store = config_service.getProvidersStore()
    if 'providers' not in store:
        store['providers'] = []

    # ── Update an existing provider ──
    if providerId:
        for rawP in as_list(store.get('providers'), []):
            p = as_dict(rawP)
            if p.get('id') == providerId:
                if name:
                    p['name'] = name
                if baseUrl:
                    p['baseUrl'] = baseUrl
                p['apiFormat'] = api_format
                if apiKey:
                    p['apiKey'] = apiKey
                config_service.saveProvidersStore(store)
                model_service.invalidateCache()
                return _ok(
                    providerId=p['id'],
                    name=p['name'],
                    baseUrl=p.get('baseUrl', ''),
                    apiFormat=p['apiFormat'],
                    needsApiKey=not bool(p.get('apiKey')),
                    keyApplied=bool(apiKey),
                )
        return _err(f"Provider '{providerId}' not found.", providerId=providerId)

    # ── Create a new provider ──
    display_name = name or suggestedName
    slug = display_name.lower().replace(' ', '-')[:40] or 'provider'
    rand = hashlib.md5(str(time.time()).encode()).hexdigest()[:6]
    new_id = f'{slug}-{rand}'

    # Apply template defaults when the chosen name matches a known template.
    resolved_url = baseUrl
    models: list[dict] = []
    for tmpl in getTemplates():
        tmpl_name = (as_str(tmpl.get('name'), '') or '').lower()
        tmpl_id = (as_str(tmpl.get('id'), '') or '').lower()
        if tmpl_name == display_name.lower() or tmpl_id == display_name.lower():
            if not resolved_url:
                resolved_url = as_str(tmpl.get('baseUrl'), '')
            if api_format == 'openaiChat':
                api_format = as_str(tmpl.get('apiFormat'), api_format)
            profiles = as_dict(tmpl.get('modelProfiles'), {})
            for key in profiles:
                if key == '*':
                    continue
                prof = as_dict(profiles.get(key), {})
                models.append({
                    'id': key,
                    'name': key,
                    'contextWindow': prof.get('contextWindow', 128000),
                    'reasoning': prof.get('supportsReasoning', False),
                    'free': False,
                    'source': 'template',
                })
            break

    entry = {
        'id': new_id,
        'name': display_name,
        'baseUrl': resolved_url,
        'apiFormat': api_format,
        'apiKey': apiKey or '',
        'enabled': True,
        'autoFetch': False,
        'models': models,
    }
    as_list(store['providers']).append(entry)
    config_service.saveProvidersStore(store)
    model_service.invalidateCache()
    return _ok(
        providerId=new_id,
        name=display_name,
        baseUrl=resolved_url,
        apiFormat=api_format,
        suggestedName=suggestedName or '',
        needsApiKey=not bool(apiKey),
        keyApplied=bool(apiKey),
    )


def register() -> None:
    """Register the setup_provider tool with the tool registry."""
    from app.services import tool_registry
    tool_registry.register(
        'setup_provider',
        (
            'Configure a model provider hands-free. First use web_search / web_fetch to find the '
            "provider's base URL and API format. Suggest a friendly name (and ask the user to "
            'confirm or rename it), then call this tool WITHOUT an apiKey to create the provider '
            'with name, baseUrl, and apiFormat pre-filled. The chat UI will then show the user an '
            'inline field to paste their API key. To finish setup, the user pastes the key into that '
            'field (preferred); or you may call this tool again with providerId + apiKey if the user '
            'pasted the key into the chat. Returns the new provider id plus a needsApiKey flag. '
            'Valid apiFormat values: openaiChat | anthropicMessages | openaiResponses.'
        ),
        setupProvider,
        {
            'type': 'object',
            'properties': {
                'name': {
                    'type': 'string',
                    'description': 'Display name for a new provider (e.g. "DeepSeek", "OpenRouter"). '
                    'Required when creating a new provider (omit only when updating via providerId).',
                },
                'baseUrl': {
                    'type': 'string',
                    'description': 'Base URL of the provider API (e.g. "https://api.deepseek.com"). '
                    'Leave empty to inherit a template default.',
                },
                'apiFormat': {
                    'type': 'string',
                    'description': 'API format: openaiChat | anthropicMessages | openaiResponses. '
                    'Common aliases (openai, anthropic, chat, messages, responses) are accepted.',
                    'default': 'openaiChat',
                },
                'suggestedName': {
                    'type': 'string',
                    'description': 'Optional provider name the model recommends; surfaced to the user '
                    'so they can confirm or rename it.',
                },
                'apiKey': {
                    'type': 'string',
                    'description': 'Usually omit on the first call. Supply only if the user has already '
                    'pasted their key into the chat (otherwise the UI field collects it).',
                    'default': '',
                },
                'providerId': {
                    'type': 'string',
                    'description': 'Id of an existing provider to update instead of creating a new one.',
                    'default': '',
                },
            },
            'required': [],
        },
    )
