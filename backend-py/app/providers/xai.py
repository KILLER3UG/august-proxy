"""
Provider config for xAI.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "xAI",
    "default_model": "grok-2",
    "default_max_tokens": 8192,
    "api_mode": "codex_responses",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.x.ai/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
