"""
Provider config for KiloCode.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'KiloCode', 'aliases': ['kilocode'], 'display_name': 'KiloCode', 'description': 'KiloCode aggregator — multi-model API gateway', 'base_url': 'https://api.kilo.ai/api/gateway', 'api_mode': 'openai_chat', 'env_vars': ['KILOCODE_API_KEY', 'KILOCODE_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'deepseek-v4-flash', 'fallback_models': ['deepseek-v4', 'deepseek-r1', 'kilo/kimi-k2', 'kilo/kimi-k2-turbo'], 'default_max_tokens': 8192, 'signup_url': 'https://kilo.ai', 'supports_health_check': True, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.kilo.ai/api/gateway'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey