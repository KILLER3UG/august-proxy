"""
Provider config for Kimi (Moonshot).
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "Kimi (Moonshot)",
    "default_model": "kimi-k2.5",
    "default_max_tokens": 128000,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.moonshot.cn/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
