"""
Provider config for DeepSeek.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'DeepSeek', 'aliases': ['ds'], 'display_name': 'DeepSeek', 'description': 'DeepSeek API — deepseek-v4 and deepseek-reasoner models', 'base_url': 'https://api.deepseek.com/v1', 'api_mode': 'openai_chat', 'env_vars': ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'deepseek-v4', 'default_max_tokens': 8192, 'signup_url': 'https://platform.deepseek.com', 'supports_health_check': True, 'model_profiles': {'deepseek-v4': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'deepseek-reasoner': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.deepseek.com/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey