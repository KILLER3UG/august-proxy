"""
Provider config for Custom (OpenAI-compatible).
"""
from __future__ import annotations
INFO: dict[str, object] = {'name': 'Custom (OpenAI-compatible)', 'aliases': ['ollama', 'vllm', 'local'], 'display_name': 'Custom (OpenAI-compatible)', 'description': 'Generic OpenAI-compatible endpoint — Ollama, vLLM, llama.cpp, etc.', 'base_url': 'http://localhost:11434/v1', 'api_mode': 'openai_chat', 'env_vars': ['CUSTOM_API_KEY', 'CUSTOM_BASE_URL'], 'auth_type': 'api_key', 'default_model': 'llama3', 'default_max_tokens': 4096, 'model_profiles': {'*': {'supportsReasoning': False, 'supportsThinking': False, 'combinedBudget': False, 'contextWindow': 32768, 'maxOutputTokens': 4096}}}

def resolveBaseUrl() -> str:
    return 'http://localhost:11434/v1'

def resolveApiKey(envKey: str | None=None) -> str | None:
    return envKey