"""
Provider config for NVIDIA NIM.
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'NVIDIA NIM', 'aliases': ['nvidia-nim', 'nim'], 'display_name': 'NVIDIA NIM', 'description': 'NVIDIA NIM — GPU-accelerated model inference', 'base_url': 'https://integrate.api.nvidia.com/v1', 'api_mode': 'openai_chat', 'env_vars': ['NVIDIA_API_KEY', 'NVIDIA_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'meta/llama-3.1-405b-instruct', 'fallback_models': ['meta/llama-3.1-405b-instruct', 'meta/llama-3.1-70b-instruct', 'mistralai/mistral-large'], 'default_max_tokens': 4096, 'signup_url': 'https://build.nvidia.com', 'supports_health_check': True, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 131072, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'https://integrate.api.nvidia.com/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey