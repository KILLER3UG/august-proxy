"""
Provider config for Nous Research (Portal).
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'Nous Research (Portal)', 'aliases': ['nous-research', 'nous-portal'], 'display_name': 'Nous Research (Portal)', 'description': 'Nous Portal API — hermes-4 and hermes-3 models', 'base_url': 'https://api.nousresearch.com/v1', 'api_mode': 'openai_chat', 'env_vars': ['NOUS_API_KEY', 'NOUS_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'hermes-4', 'fallback_models': ['hermes-4-flash', 'hermes-3', 'hermes-3-flash'], 'default_max_tokens': 8192, 'signup_url': 'https://nousresearch.com', 'supports_health_check': True, 'model_profiles': {'hermes-4': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'hermes-4-flash': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'hermes-3': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'hermes-3-flash': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.nousresearch.com/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey