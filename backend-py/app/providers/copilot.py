"""
Provider config for GitHub Copilot.
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'GitHub Copilot', 'aliases': ['github-copilot'], 'display_name': 'GitHub Copilot', 'description': 'GitHub Copilot — OpenAI-compatible endpoint', 'base_url': 'https://api.githubcopilot.com', 'api_mode': 'openai_chat', 'env_vars': ['COPILOT_API_KEY', 'COPILOT_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'gpt-4o', 'fallback_models': ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4', 'claude-haiku-4-5'], 'default_max_tokens': 4096, 'signup_url': 'https://github.com/features/copilot', 'supports_health_check': True, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 128000, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.githubcopilot.com'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey