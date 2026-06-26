"""
Provider config for GMI Cloud.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "GMI Cloud",
    "aliases": [
    "gmi-cloud"
],
    "display_name": "GMI Cloud",
    "description": "GMI Cloud API \u2014 hosted open models",
    "base_url": "https://api.gmi.cloud/v1",
    "api_mode": "openai_chat",
    "env_vars": [
    "GMI_API_KEY",
    "GMI_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "gmi-llama-3.1-70b",
    "fallback_models": [
    "gmi-llama-3.1-405b",
    "gmi-hermes-4"
],
    "default_max_tokens": 8192,
    "signup_url": "https://gmi.cloud",
    "supports_health_check": True,
    "model_profiles": {
    "gmi-llama-3.1-405b": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "gmi-llama-3.1-70b": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "gmi-hermes-4": {
    "supportsReasoning": True,
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
    return "https://api.gmi.cloud/v1"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
