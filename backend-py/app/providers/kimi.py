"""
Provider config for Kimi (Moonshot).
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'Kimi (Moonshot)', 'aliases': ['kimi', 'moonshot', 'kimi-coding'], 'display_name': 'Kimi (Moonshot)', 'description': 'Kimi/Moonshot API — kimi-k2 reasoning and moonshot-v1 models', 'base_url': 'https://api.moonshot.cn/v1', 'api_mode': 'openai_chat', 'env_vars': ['MOONSHOT_API_KEY', 'MOONSHOT_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'kimi-k2', 'fallback_models': ['kimi-k2-turbo', 'moonshot-v1-128k'], 'default_max_tokens': 8192, 'signup_url': 'https://platform.moonshot.cn', 'supports_health_check': True, 'model_profiles': {'kimi-k2': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'kimi-k2-turbo': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'moonshot-v1-8k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 8192, 'maxOutputTokens': 4096}, 'moonshot-v1-32k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 32768, 'maxOutputTokens': 4096}, 'moonshot-v1-128k': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.moonshot.cn/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey