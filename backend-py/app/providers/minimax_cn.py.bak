"""
Provider config for MiniMax (China).
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "MiniMax (China)",
    "display_name": "MiniMax (China)",
    "description": "MiniMax China endpoint \u2014 M2.5 and M2.7 models",
    "base_url": "https://minimax.qlangtech.com/anthropic",
    "api_mode": "anthropic_messages",
    "env_vars": [
    "MINIMAX_CN_API_KEY",
    "MINIMAX_CN_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "minimax-m2.7",
    "fallback_models": [
    "minimax-m2.7",
    "minimax-m2.5"
],
    "default_max_tokens": 64000,
    "signup_url": "https://platform.minimaxi.com",
    "model_profiles": {
    "minimax-m2.7": {
    "supportsReasoning": True,
    "supportsThinking": True,
    "combinedBudget": True,
    "contextWindow": 204800,
    "maxOutputTokens": 64000,
    "temperature": 1,
    "topP": 0.95,
    "topK": 40,
    "thinkingReserve": 4096,
    "safetyBuffer": 2000
},
    "minimax-m2.5": {
    "supportsReasoning": True,
    "supportsThinking": True,
    "combinedBudget": False,
    "contextWindow": 245760,
    "maxOutputTokens": 8192,
    "temperature": 1,
    "topP": 0.95,
    "topK": 40
},
    "*": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "contextWindow": 131072,
    "maxOutputTokens": 4096
}
},
}


def resolve_base_url() -> str:
    return "https://minimax.qlangtech.com/anthropic"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
