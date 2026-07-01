"""
Provider config for xAI.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'xAI', 'aliases': ['grok'], 'display_name': 'xAI', 'description': 'xAI API — Grok models', 'base_url': 'https://api.x.ai/v1', 'api_mode': 'codex_responses', 'env_vars': ['XAI_API_KEY', 'XAI_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'grok-3', 'default_max_tokens': 8192, 'signup_url': 'https://console.x.ai', 'supports_health_check': True, 'model_profiles': {'grok-3': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'grok-2': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.x.ai/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey