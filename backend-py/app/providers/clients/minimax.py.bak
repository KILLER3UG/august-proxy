"""MiniMax API client.

MiniMax uses the Anthropic Messages API format but has its own auth
header (``Bearer`` with a MiniMax-specific key) and default parameters.

Port of the MiniMax-specific portions of backend/adapters/base.js and
backend/providers/minimax.js / minimax-cn.js.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from app.providers.clients.anthropic import AnthropicClient
from app.providers.clients.base import ProviderResponse


class MiniMaxClient(AnthropicClient):
    """Client for MiniMax's Anthropic-compatible endpoint.

    Uses the same Anthropic Messages API format with MiniMax-specific:
    - Base URL (``api.minimax.io/anthropic`` or ``minimax.qlangtech.com/anthropic``)
    - Default parameters (temperature=1, top_p=0.95, top_k=40)
    - Combined thinking/output budget
    """

    api_format = "minimax"

    def resolve_base_url(self) -> str:
        """Resolve the MiniMax API URL.

        MiniMax provides an Anthropic-compatible endpoint.
        The base URL already includes the /anthropic path.
        """
        base = super().resolve_base_url()
        if not base:
            # Use the provider's default base URL from config
            base = self.config.get("base_url", "https://api.minimax.io/anthropic")
        return base.rstrip("/")
