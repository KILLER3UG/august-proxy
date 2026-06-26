"""
Provider config for Google AI Studio.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "Google AI Studio",
    "default_model": "gemini-2.0-flash",
    "default_max_tokens": 8192,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://generativelanguage.googleapis.com/v1beta/openai"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
