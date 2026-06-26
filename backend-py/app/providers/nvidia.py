"""
Provider config for NVIDIA NIM.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "NVIDIA NIM",
    "default_model": "meta-llama-3.1-405b",
    "default_max_tokens": 8192,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://integrate.api.nvidia.com/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
