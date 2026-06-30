"""
Provider config for Hugging Face.
"""
from __future__ import annotations
from typing import Any
INFO: dict[str, Any] = {'name': 'Hugging Face', 'aliases': ['hf'], 'display_name': 'Hugging Face', 'description': 'Hugging Face Inference Endpoints — open models', 'base_url': 'https://api-inference.huggingface.co/v1', 'api_mode': 'openai_chat', 'env_vars': ['HUGGINGFACE_API_KEY', 'HUGGINGFACE_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'meta-llama/Llama-3.1-70B-Instruct', 'default_max_tokens': 4096, 'signup_url': 'https://huggingface.co', 'supports_health_check': True, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://api-inference.huggingface.co/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey