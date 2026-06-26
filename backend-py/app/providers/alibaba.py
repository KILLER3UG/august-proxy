"""
Provider config for Alibaba Cloud (Qwen).
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "Alibaba Cloud (Qwen)",
    "default_model": "qwen-max",
    "default_max_tokens": 8192,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://dashscope.aliyuncs.com/compatible-mode/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
