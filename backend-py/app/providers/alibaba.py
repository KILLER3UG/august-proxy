"""
Provider config for Alibaba Cloud (Qwen).
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'Alibaba Cloud (Qwen)', 'aliases': ['qwen', 'alibaba-cloud'], 'display_name': 'Alibaba Cloud (Qwen)', 'description': 'Alibaba Cloud DashScope API — Qwen and QwQ models', 'base_url': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'api_mode': 'openai_chat', 'env_vars': ['ALIBABA_API_KEY', 'ALIBABA_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'qwen3', 'fallback_models': ['qwen-plus', 'qwen-max', 'qwq-32b'], 'default_max_tokens': 8192, 'signup_url': 'https://dashscope.aliyun.com', 'supports_health_check': True, 'model_profiles': {'qwen3': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'qwen-turbo': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'qwen-plus': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'qwen-max': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'qwq-32b': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://dashscope.aliyuncs.com/compatible-mode/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey