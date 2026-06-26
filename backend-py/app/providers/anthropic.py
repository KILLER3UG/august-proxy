"""
Provider config for Anthropic.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "Anthropic",
    "default_model": "claude-sonnet-4-7",
    "default_max_tokens": 8192,
    "api_mode": "anthropic_messages",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.anthropic.com"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
