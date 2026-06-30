"""
Provider config for Azure AI Foundry.
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'Azure AI Foundry', 'aliases': ['azure'], 'display_name': 'Azure AI Foundry', 'description': 'Azure AI Foundry — OpenAI models via Azure', 'api_mode': 'openai_chat', 'env_vars': ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'], 'auth_type': 'api_key', 'default_model': 'gpt-4o', 'default_max_tokens': 4096, 'signup_url': 'https://ai.azure.com', 'supports_health_check': True, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 128000, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return ''

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey