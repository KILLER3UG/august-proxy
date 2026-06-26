"""
Provider config for OpenAI API.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "OpenAI API",
    "default_model": "gpt-4o",
    "default_max_tokens": 16384,
    "api_mode": "codex_responses",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.openai.com/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
