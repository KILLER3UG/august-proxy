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

from app.json_narrowing import as_dict, as_list
from app.providers.api_format import normalize_api_format as _normalize_format


def _ok(**fields: object) -> str:
    return json.dumps({'status': 'success', **fields}, default=str)


def _err(message: str, **fields: object) -> str:
    return json.dumps({'status': 'error', 'error': message, **fields}, default=str)


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
                model_service.invalidate_cache()
                return _ok(
                    providerId=p['id'],
                    name=p['name'],
                    baseUrl=p.get('baseUrl', ''),
                    apiFormat=p['apiFormat'],
                    needsApiKey=not bool(p.get('apiKey')),
                    keyApplied=bool(apiKey),
                )
        return _err(f"Provider '{providerId}' not found.", providerId=providerId)

    # ── Create a new provider (user-configured; no templates) ──
    display_name = name or suggestedName
    slug = display_name.lower().replace(' ', '-')[:40] or 'provider'
    rand = hashlib.md5(str(time.time()).encode()).hexdigest()[:6]
    new_id = f'{slug}-{rand}'

    resolved_url = (baseUrl or '').strip()
    if not resolved_url:
        return _err(
            "baseUrl is required. Look up the provider's API base URL "
            '(e.g. https://api.openai.com/v1) and pass it to setup_provider.'
        )

    entry = {
        'id': new_id,
        'name': display_name,
        'baseUrl': resolved_url,
        'apiFormat': api_format,
        'apiKey': apiKey or '',
        'enabled': True,
        'autoFetch': False,
        'models': [],
    }
    as_list(store['providers']).append(entry)
    config_service.saveProvidersStore(store)
    model_service.invalidate_cache()
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
