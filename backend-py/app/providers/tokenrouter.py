"""
Provider config for Token Router.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "Token Router",
    "aliases": [
    "tr"
],
    "display_name": "Token Router",
    "description": "Token Router API \u2014 AI routing gateway with auto:balance, auto:cost, auto:quality and auto:latency modes",
    "base_url": "https://api.tokenrouter.com/v1",
    "api_mode": "openai_chat",
    "env_vars": [
    "TOKENROUTER_API_KEY",
    "TOKENROUTER_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "auto:balance",
    "default_max_tokens": 8192,
    "signup_url": "https://tokenrouter.me",
    "supports_health_check": True,
    "model_profiles": {
    "auto:balance": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 128000,
    "maxOutputTokens": 8192
},
    "auto:cost": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 128000,
    "maxOutputTokens": 8192
},
    "auto:quality": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 128000,
    "maxOutputTokens": 8192
},
    "auto:latency": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 128000,
    "maxOutputTokens": 8192
},
    "*": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 128000,
    "maxOutputTokens": 4096
}
},
}


def resolve_base_url() -> str:
    return "https://api.tokenrouter.com/v1"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
