"""
Provider config for StepFun.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "StepFun",
    "default_model": "step-3.7-flash",
    "default_max_tokens": 8192,
    "api_mode": "openai_chat",
}


def resolve_base_url() -> Optional[str]:
    return "https://api.stepfun.com/v1"


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
