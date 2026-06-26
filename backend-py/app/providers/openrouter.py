"""
Provider config for OpenRouter.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "OpenRouter",
    "aliases": [
    "or"
],
    "display_name": "OpenRouter",
    "description": "OpenRouter \u2014 multi-model API aggregator",
    "base_url": "https://openrouter.ai/api/v1",
    "api_mode": "openai_chat",
    "env_vars": [
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "auto",
    "default_max_tokens": 4096,
    "default_headers": {
    "HTTP-Referer": "https://github.com/robert/august-proxy",
    "X-Title": "August Proxy"
},
    "signup_url": "https://openrouter.ai",
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
    return "https://openrouter.ai/api/v1"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
