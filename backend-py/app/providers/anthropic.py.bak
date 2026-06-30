"""
Provider config for Anthropic.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "Anthropic",
    "aliases": [
    "claude"
],
    "display_name": "Anthropic",
    "description": "Anthropic Messages API \u2014 Claude models",
    "base_url": "https://api.anthropic.com/v1/messages",
    "api_mode": "anthropic_messages",
    "env_vars": [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "claude-sonnet-4-6",
    "default_max_tokens": 8192,
    "default_headers": {
    "anthropic-version": "2023-06-01"
},
    "signup_url": "https://console.anthropic.com",
    "supports_health_check": True,
    "model_profiles": {
    "claude-opus-4": {
    "supportsReasoning": True,
    "supportsThinking": True,
    "combinedBudget": False,
    "contextWindow": 200000,
    "maxOutputTokens": 8192
},
    "claude-sonnet-4": {
    "supportsReasoning": True,
    "supportsThinking": True,
    "combinedBudget": False,
    "contextWindow": 200000,
    "maxOutputTokens": 8192
},
    "claude-3": {
    "supportsReasoning": False,
    "supportsThinking": True,
    "combinedBudget": False,
    "contextWindow": 200000,
    "maxOutputTokens": 4096
},
    "*": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 200000,
    "maxOutputTokens": 4096
}
},
}


def resolve_base_url() -> str:
    return "https://api.anthropic.com/v1/messages"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
