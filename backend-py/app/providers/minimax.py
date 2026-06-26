"""
Provider config for MiniMax (Global).
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "MiniMax (Global)",
    "default_model": "minimax-m3",
    "default_max_tokens": 64000,
    "api_mode": "anthropic_messages",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.minimax.chat/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
