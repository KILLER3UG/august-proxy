"""
Provider config for OpenRouter.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "OpenRouter",
    "default_model": "gpt-4o",
    "default_max_tokens": 16384,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://openrouter.ai/api/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
