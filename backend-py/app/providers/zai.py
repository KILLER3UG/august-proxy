"""
Provider config for Zhipu AI (GLM).
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "Zhipu AI (GLM)",
    "default_model": "glm-5",
    "default_max_tokens": 8192,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://open.bigmodel.cn/api/paas/v4"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
