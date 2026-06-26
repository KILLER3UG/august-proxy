"""
Provider config for OpenCode Go.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "OpenCode Go",
    "default_model": "deepseek-v4",
    "default_max_tokens": 64000,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://opencode.ai/zen/go/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
