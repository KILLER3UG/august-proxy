"""Provider client factory — returns the right client for a provider config."""
from __future__ import annotations
from typing import Any
from app.providers.clients.base import BaseProviderClient
from app.providers.clients.anthropic import AnthropicClient
from app.providers.clients.openai import OpenAIClient
from app.providers.clients.gemini import GeminiClient
from app.providers.clients.minimax import MiniMaxClient
from app.providers.clients.bedrock import BedrockClient

def getClient(providerConfig: dict[str, Any]) -> BaseProviderClient | None:
    """Return the appropriate client for a provider's ``api_mode``.

    Args:
        provider_config: A provider config dict (from the registry).

    Returns:
        A client instance, or ``None`` if the api_mode is unknown.
    """
    mode = providerConfig.get('api_mode', 'openai_chat')
    match mode:
        case 'anthropic_messages':
            return AnthropicClient(providerConfig)
        case 'openai_chat' | 'codex_responses':
            return OpenAIClient(providerConfig)
        case 'gemini_openai':
            return GeminiClient(providerConfig)
        case 'minimax':
            return MiniMaxClient(providerConfig)
        case 'bedrock_converse':
            return BedrockClient(providerConfig)
        case _:
            return OpenAIClient(providerConfig)
__all__ = ['BaseProviderClient', 'AnthropicClient', 'OpenAIClient', 'GeminiClient', 'MiniMaxClient', 'BedrockClient', 'getClient']