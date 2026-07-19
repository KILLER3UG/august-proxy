"""MiniMax API client.

MiniMax uses the Anthropic Messages API format but has its own auth
header (``Bearer`` with a MiniMax-specific key) and default parameters.

Port of the MiniMax-specific portions of backend/adapters/base.js and
backend/providers/minimax.js / minimax-cn.js.
"""

from __future__ import annotations
from app.json_narrowing import as_str
from app.providers.clients.anthropic import AnthropicClient


class MiniMaxClient(AnthropicClient):
    """Client for MiniMax's Anthropic-compatible endpoint.

    Uses the same Anthropic Messages API format with MiniMax-specific:
    - Base URL (``api.minimax.io/anthropic`` or ``minimax.qlangtech.com/anthropic``)
    - Default parameters (temperature=1, top_p=0.95, top_k=40)
    - Combined thinking/output budget
    """

    apiFormat = 'minimax'

    def resolveBaseUrl(self) -> str:
        """MiniMax Anthropic-compatible host+prefix ending in ``/v1``."""
        from app.providers.api_format import anthropic_v1_base, normalize_provider_base_url
        from app.providers.clients.base import BaseProviderClient

        # Skip AnthropicClient.resolveBaseUrl (anthropic.com default).
        base = normalize_provider_base_url(BaseProviderClient.resolveBaseUrl(self))
        if not base:
            base = as_str(self.config.get('baseUrl'), 'https://api.minimax.io/anthropic')
        return anthropic_v1_base(base)
