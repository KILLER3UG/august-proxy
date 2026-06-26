"""
Provider config for OpenCode Zen.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "OpenCode Zen",
    "aliases": [
    "zen"
],
    "display_name": "OpenCode Zen",
    "description": "OpenCode Zen API \u2014 single-model direct access",
    "base_url": "https://opencode.ai/zen/v1",
    "api_mode": "openai_chat",
    "env_vars": [
    "OPENCODE_ZEN_API_KEY",
    "OPENCODE_ZEN_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "deepseek-v4-flash",
    "fallback_models": [
    "deepseek-v4",
    "deepseek-v4-flash",
    "deepseek-r1"
],
    "default_max_tokens": 8192,
    "signup_url": "https://opencode.ai",
    "supports_health_check": True,
    "model_profiles": {
    "deepseek-v4": {
    "supportsReasoning": True,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "kimi-k2": {
    "supportsReasoning": True,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "glm-5": {
    "supportsReasoning": True,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "qwen3": {
    "supportsReasoning": True,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "mimo-v2": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "*": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 4096
}
},
}


def resolve_base_url() -> str:
    return "https://opencode.ai/zen/v1"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
