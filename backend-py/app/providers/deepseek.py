"""
Provider config for DeepSeek.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "DeepSeek",
    "default_model": "deepseek-chat",
    "default_max_tokens": 8192,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.deepseek.com/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
