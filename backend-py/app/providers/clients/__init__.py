"""Provider client factory — returns the right client for a provider config."""

from __future__ import annotations
from app.providers.clients.base import BaseProviderClient
from app.providers.clients.anthropic import AnthropicClient
from app.providers.clients.openai import OpenAIClient
from app.providers.clients.gemini import GeminiClient
from app.providers.clients.minimax import MiniMaxClient
from app.providers.clients.bedrock import BedrockClient


def getClient(providerConfig: dict[str, object]) -> BaseProviderClient | None:
    """Return the appropriate client for a provider's ``api_mode``.

    Args:
        provider_config: A provider config dict (from the registry).

    Returns:
        A client instance, or ``None`` if the api_mode is unknown.
    """
    mode = providerConfig.get('apiMode', 'openaiChat')
    match mode:
        case 'anthropicMessages':
            return AnthropicClient(providerConfig)
        case 'openaiChat' | 'openaiChat' | 'codexResponses':
            return OpenAIClient(providerConfig)
        case 'geminiOpenai':
            return GeminiClient(providerConfig)
        case 'minimax':
            return MiniMaxClient(providerConfig)
        case 'bedrockConverse':
            return BedrockClient(providerConfig)
        case _:
            return OpenAIClient(providerConfig)


__all__ = [
    'BaseProviderClient',
    'AnthropicClient',
    'OpenAIClient',
    'GeminiClient',
    'MiniMaxClient',
    'BedrockClient',
    'getClient',
]
