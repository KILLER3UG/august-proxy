"""
Provider config for Novita AI.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "Novita AI",
    "default_model": "gpt-4o",
    "default_max_tokens": 8192,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.novita.ai/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
