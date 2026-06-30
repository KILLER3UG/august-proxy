"""
Provider config for Google AI Studio.
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "Google AI Studio",
    "aliases": [
    "google"
],
    "display_name": "Google AI Studio",
    "description": "Google AI Studio \u2014 Gemini models via OpenAI-compatible endpoint",
    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "api_mode": "gemini_openai",
    "env_vars": [
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "gemini-2.0-flash",
    "default_max_tokens": 8192,
    "signup_url": "https://aistudio.google.com",
    "supports_health_check": True,
    "model_profiles": {
    "gemini-2": {
    "supportsReasoning": True,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 1048576,
    "maxOutputTokens": 8192
},
    "gemini-1": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 1048576,
    "maxOutputTokens": 8192
},
    "*": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 1048576,
    "maxOutputTokens": 4096
}
},
}


def resolve_base_url() -> str:
    return "https://generativelanguage.googleapis.com/v1beta/openai/"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
