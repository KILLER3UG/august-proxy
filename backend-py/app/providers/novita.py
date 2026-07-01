"""
Provider config for Novita AI.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'Novita AI', 'display_name': 'Novita AI', 'description': 'Novita AI — multi-model API gateway', 'base_url': 'https://api.novita.ai/v3/openai', 'api_mode': 'openai_chat', 'env_vars': ['NOVITA_API_KEY', 'NOVITA_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'deepseek-v4', 'fallback_models': ['deepseek-v4', 'deepseek-r1', 'llama-3.1-70b'], 'default_max_tokens': 8192, 'signup_url': 'https://novita.ai', 'supports_health_check': True, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.novita.ai/v3/openai'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey