"""
Provider config for Zhipu AI (GLM).
"""

from __future__ import annotations

from typing import Any


INFO: dict[str, Any] = {
    "name": "Zhipu AI (GLM)",
    "aliases": [
    "glm",
    "zhipu",
    "zhi-ai"
],
    "display_name": "Zhipu AI (GLM)",
    "description": "Zhipu AI (\u667a\u8c31AI) API \u2014 GLM and CodeGeeX models",
    "base_url": "https://open.bigmodel.cn/api/paas/v4",
    "api_mode": "openai_chat",
    "env_vars": [
    "ZHIPU_API_KEY",
    "ZHIPU_BASE_URL"
],
    "auth_type": "api_key",
    "default_model": "glm-5",
    "fallback_models": [
    "glm-5-flash",
    "glm-4-plus",
    "glm-4v-plus"
],
    "default_max_tokens": 8192,
    "signup_url": "https://open.bigmodel.cn",
    "supports_health_check": True,
    "model_profiles": {
    "glm-5": {
    "supportsReasoning": True,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "glm-5-flash": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "glm-4-plus": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "glm-4v-plus": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 8192
},
    "glm-4-air": {
    "supportsReasoning": False,
    "supportsThinking": False,
    "combinedBudget": False,
    "contextWindow": 131072,
    "maxOutputTokens": 4096
},
    "codegeex-4": {
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
    return "https://open.bigmodel.cn/api/paas/v4"


def resolve_api_key(env_key: str | None = None) -> str | None:
    return env_key
