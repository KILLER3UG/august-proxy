"""Provider client factory — returns the right client for a provider config.

Reuses client instances per provider identity (id + apiMode + baseUrl) so the
underlying ``httpx.AsyncClient`` connection pool is shared across requests.
``BaseProviderClient`` already creates one HTTP client per instance; pooling
here avoids constructing a new client object on every call.

Only wire formats users configure: openaiChat / openaiResponses / codexResponses
→ OpenAIClient; anthropicMessages → AnthropicClient. No first-class Gemini /
MiniMax / Bedrock clients — paste an OpenAI-compatible or Anthropic baseUrl.
"""

from __future__ import annotations

import threading

from app.providers.clients.base import BaseProviderClient
from app.providers.clients.anthropic import AnthropicClient
from app.providers.clients.openai import OpenAIClient

_lock = threading.Lock()
_client_pool: dict[str, BaseProviderClient] = {}


def _pool_key(providerConfig: dict[str, object]) -> str:
    from app.providers.api_format import normalize_api_format

    mode = normalize_api_format(
        providerConfig.get('apiMode') or providerConfig.get('apiFormat'),
        default='openaiChat',
    )
    return '|'.join(
        (
            str(providerConfig.get('id') or providerConfig.get('name') or ''),
            mode,
            str(providerConfig.get('baseUrl') or providerConfig.get('base_url') or ''),
        )
    )


def _make_client(providerConfig: dict[str, object]) -> BaseProviderClient:
    from app.providers.api_format import normalize_api_format

    mode = normalize_api_format(
        providerConfig.get('apiMode') or providerConfig.get('apiFormat'),
        default='openaiChat',
    )
    match mode:
        case 'anthropicMessages':
            return AnthropicClient(providerConfig)
        case 'openaiChat' | 'openaiResponses' | 'codexResponses':
            return OpenAIClient(providerConfig)
        case _:
            return OpenAIClient(providerConfig)


def getClient(providerConfig: dict[str, object]) -> BaseProviderClient | None:
    """Return a pooled client for a provider's ``api_mode``.

    Same provider id + apiMode + baseUrl reuses the instance (and its httpx
    connection pool). Pass a fresh config dict after credential rotation if
    the base URL or identity changes.
    """
    if not providerConfig:
        return None
    key = _pool_key(providerConfig)
    with _lock:
        client = _client_pool.get(key)
        if client is None:
            client = _make_client(providerConfig)
            _client_pool[key] = client
        else:
            # Keep config pointer fresh for api key resolution
            client.config = providerConfig
        return client


def clear_client_pool() -> None:
    """Drop pooled clients (tests / credential rotation)."""
    with _lock:
        _client_pool.clear()


__all__ = [
    'BaseProviderClient',
    'AnthropicClient',
    'OpenAIClient',
    'getClient',
    'clear_client_pool',
]
