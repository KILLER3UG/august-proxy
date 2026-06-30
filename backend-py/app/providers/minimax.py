"""
Provider config for MiniMax (Global).
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'MiniMax (Global)', 'aliases': ['minimax-global'], 'display_name': 'MiniMax (Global)', 'description': 'MiniMax global API — M2.5 and M2.7 models via Anthropic-compatible endpoint', 'base_url': 'https://api.minimax.io/anthropic', 'api_mode': 'anthropic_messages', 'env_vars': ['MINIMAX_API_KEY', 'MINIMAX_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'minimax-m2.7', 'fallback_models': ['minimax-m2.7', 'minimax-m2.5', 'minimax-t2.5'], 'default_max_tokens': 64000, 'signup_url': 'https://platform.minimaxi.com', 'supports_health_check': True, 'model_profiles': {'minimax-m2.7': {'supportsReasoning': True, 'supportsThinking': True, 'combinedBudget': True, 'contextWindow': 204800, 'maxOutputTokens': 64000, 'temperature': 1, 'topP': 0.95, 'topK': 40, 'thinkingReserve': 4096, 'safetyBuffer': 2000}, 'minimax-m2.5': {'supportsReasoning': True, 'supportsThinking': True, 'combinedBudget': False, 'contextWindow': 245760, 'maxOutputTokens': 8192, 'temperature': 1, 'topP': 0.95, 'topK': 40, 'thinkingReserve': 0, 'safetyBuffer': 2000}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api.minimax.io/anthropic'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey