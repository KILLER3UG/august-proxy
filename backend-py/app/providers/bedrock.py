"""
Provider config for AWS Bedrock.
"""

from __future__ import annotations

from typing import Optional

INFO = {
    "name": "AWS Bedrock",
    "default_model": "anthropic.claude-v2",
    "default_max_tokens": 8192,
    "api_mode": "bedrock_converse",
}


def resolve_base_url() -> Optional[str]:
    return None


def resolve_api_key(env_key: Optional[str] = None) -> Optional[str]:
    return env_key
