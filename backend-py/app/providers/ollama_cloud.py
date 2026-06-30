"""
Provider config for Ollama Cloud.
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'Ollama Cloud', 'aliases': ['ollama-cloud-hosted'], 'display_name': 'Ollama Cloud', 'description': 'Ollama Cloud hosted API — open models on demand', 'base_url': 'https://cloud.ollama.ai/api/chat', 'api_mode': 'openai_chat', 'env_vars': ['OLLAMA_CLOUD_API_KEY', 'OLLAMA_CLOUD_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'llama-3.1-70b', 'fallback_models': ['llama-3.1-8b', 'qwen2.5-72b', 'mistral-large'], 'default_max_tokens': 8192, 'signup_url': 'https://ollama.ai', 'supports_health_check': True, 'model_profiles': {'llama-3.1-70b': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'llama-3.1-8b': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'qwen2.5-72b': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'qwen2.5-coder-32b': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'mistral-large': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, 'deepseek-v4': {'supportsReasoning': True, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 8192}, '*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://cloud.ollama.ai/api/chat'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey