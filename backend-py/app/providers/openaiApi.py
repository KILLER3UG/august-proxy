"""
Provider config for OpenAI API.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'OpenAI API', 'aliases': ['openai', 'gpt'], 'display_name': 'OpenAI API', 'description': 'OpenAI Chat Completions API — GPT models', 'base_url': 'https://api.openai.com/v1', 'api_mode': 'codex_responses', 'env_vars': ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'gpt-4o', 'default_max_tokens': 4096, 'signup_url': 'https://platform.openai.com', 'supports_health_check': True, 'model_profiles': {'gpt-4': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 128000, 'maxOutputTokens': 16384}, 'gpt-3': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 16385, 'maxOutputTokens': 4096}, 'o1': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 200000, 'maxOutputTokens': 100000}, 'o3': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 200000, 'maxOutputTokens': 100000}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 128000, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.openai.com/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey