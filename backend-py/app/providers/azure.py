"""
Provider config for Azure AI Foundry.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "Azure AI Foundry",
    "default_model": "gpt-4o",
    "default_max_tokens": 16384,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return None


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
