"""
Provider config for OpenRouter.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'OpenRouter', 'aliases': ['or'], 'display_name': 'OpenRouter', 'description': 'OpenRouter — multi-model API aggregator', 'base_url': 'https://openrouter.ai/api/v1', 'api_mode': 'openai_chat', 'env_vars': ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'auto', 'default_max_tokens': 4096, 'default_headers': {'HTTP-Referer': 'https://github.com/robert/august-proxy', 'X-Title': 'August Proxy'}, 'signup_url': 'https://openrouter.ai', 'supports_health_check': True, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://openrouter.ai/api/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey