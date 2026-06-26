"""
Provider config for Arcee AI.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "Arcee AI",
    "aliases": [
    "arcee-ai"
],
    "display_name": "Arcee AI",
    "description": "Arcee AI API \u2014 supernova models",
    "base_url": "https://api.arcee.ai/v1",
    "api_mode": "openai_chat",
    "env_vars": [
    "ARCEE_API_KEY",
    "ARCEE_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "supernova-70b",
    "fallback_models": [
    "supernova-8b",
    "supernova-7b"
],
    "default_max_tokens": 4096,
    "signup_url": "https://arcee.ai",
    "model_profiles": {
    "supernova-7b": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 32768,
    "maxOutputTokens": 4096
},
    "supernova-8b": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 32768,
    "maxOutputTokens": 4096
},
    "supernova-70b": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 65536,
    "maxOutputTokens": 4096
},
    "arcee-v2": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 65536,
    "maxOutputTokens": 4096
},
    "*": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 32768,
    "maxOutputTokens": 4096
}
},
}


def resolve_base_url() -> str:
    return "https://api.arcee.ai/v1"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
