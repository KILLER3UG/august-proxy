"""
Provider config for AI Gateway.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "AI Gateway",
    "aliases": [
    "gateway",
    "llm-gateway"
],
    "display_name": "AI Gateway",
    "description": "Generic AI Gateway proxy \u2014 pass-through to upstream providers",
    "base_url": "https://gateway.ai.cloudflare.com/v1",
    "api_mode": "openai_chat",
    "env_vars": [
    "AI_GATEWAY_API_KEY",
    "AI_GATEWAY_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "generic",
    "default_max_tokens": 4096,
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
    return "https://gateway.ai.cloudflare.com/v1"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
