"""
Provider config for Xiaomi MiMo.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'Xiaomi MiMo', 'aliases': ['mimo', 'xiaomi-mimo'], 'display_name': 'Xiaomi MiMo', 'description': 'Xiaomi MiMo API — reasoning and flash models', 'base_url': 'https://api.mimo.xyz/v1', 'api_mode': 'openai_chat', 'env_vars': ['XIAOMI_API_KEY', 'XIAOMI_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'mimo-v2', 'fallback_models': ['mimo-v2-flash', 'mimo-v1'], 'default_max_tokens': 8192, 'signup_url': 'https://mimo.xyz', 'supports_health_check': True, 'model_profiles': {'mimo-v2': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'mimo-v2-flash': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'mimo-v1': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 32768, 'maxOutputTokens': 4096}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.mimo.xyz/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey