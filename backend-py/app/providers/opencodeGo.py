"""
Provider config for OpenCode Go.
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'OpenCode Go', 'aliases': ['opencode', 'go'], 'display_name': 'OpenCode Go', 'description': 'OpenCode Go aggregator — multi-model access', 'base_url': 'https://opencode.ai/zen/go/v1/chat/completions', 'api_mode': 'openai_chat', 'env_vars': ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'deepseek-v4-flash', 'fallback_models': ['deepseek-v4', 'deepseek-v4-flash', 'deepseek-r1', 'qwen-max'], 'default_max_tokens': 8192, 'signup_url': 'https://opencode.ai', 'supports_health_check': True, 'model_profiles': {'deepseek-v4': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'kimi-k2': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'glm-5': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'qwen3': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'mimo-v2': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://opencode.ai/zen/go/v1/chat/completions'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey