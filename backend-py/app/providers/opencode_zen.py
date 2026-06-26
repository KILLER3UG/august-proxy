"""
Provider config for OpenCode Zen.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "OpenCode Zen",
    "default_model": "deepseek-v4-flash",
    "default_max_tokens": 64000,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://opencode.ai/zen/go/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
