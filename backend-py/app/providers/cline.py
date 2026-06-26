"""
Provider config for Cline AI.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "Cline AI",
    "aliases": [
    "cline-ai"
],
    "display_name": "Cline AI",
    "description": "Cline AI \u2014 OpenRouter-based model access",
    "base_url": "https://api.cline.bot/api/v1",
    "api_mode": "openai_chat",
    "env_vars": [
    "CLINE_API_KEY",
    "CLINE_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "minimax-m2.5",
    "fallback_models": [
    "minimax-m2.5",
    "minimax-m2.7",
    "deepseek-v4"
],
    "default_max_tokens": 8192,
    "signup_url": "https://cline.bot",
    "supports_health_check": True,
    "model_profiles": {
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
    return "https://api.cline.bot/api/v1"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
