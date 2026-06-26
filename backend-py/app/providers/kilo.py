"""
Provider config for KiloCode.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "KiloCode",
    "default_model": "deepseek-v4-flash",
    "default_max_tokens": 64000,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.kilocode.ai/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
