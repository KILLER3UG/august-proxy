"""Anthropic Messages API client.

Port of the HTTP transport portions of backend/adapters/anthropic.js.

Handles:
- POST /v1/messages (streaming and non-streaming)
- Anthropic-specific headers (``anthropic-version``)
- Content-block SSE event parsing
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from app.providers.clients.base import BaseProviderClient, ProviderResponse


class AnthropicClient(BaseProviderClient):
    """Client for the Anthropic Messages API (``api_mode: anthropic_messages``)."""

    api_format = "anthropic_messages"

    def build_auth_headers(self, api_key: str | None) -> dict[str, str]:
        """Build headers for the Anthropic API.

        Includes the required ``anthropic-version`` header and optional
        ``anthropic-beta`` headers from provider config.
        """
        headers = super().build_auth_headers(api_key)
        headers.setdefault("anthropic-version", "2023-06-01")
        # Pass through any anthropic-beta headers from config
        beta = self.config.get("anthropic_beta")
        if beta:
            headers["anthropic-beta"] = beta
        return headers

    def resolve_base_url(self) -> str:
        """Resolve the Anthropic API URL.

        Defaults to ``https://api.anthropic.com``.
        """
        base = super().resolve_base_url()
        if not base:
            base = "https://api.anthropic.com"
        return base.rstrip("/") + "/v1"

    async def messages(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> ProviderResponse:
        """Non-streaming call to POST /v1/messages."""
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/messages"
        return await self.request_json("POST", url, headers, body)

    async def generate(self, prompt: str, system: str | None = None) -> str:
        """v2: Anthropic-specific generate using the messages API."""
        body: dict[str, Any] = {
            "model": self.config.get("model", ""),
            "max_tokens": 2048,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            body["system"] = system
        try:
            resp = await self.messages(body)
        except (AttributeError, TypeError):
            return ""
        if resp.status != 200:
            return ""
        body_data = resp.body if isinstance(resp.body, dict) else {}
        content = body_data.get("content", [])
        if isinstance(content, list) and content:
            block = content[0]
            if isinstance(block, dict):
                return block.get("text", "")
        return ""

    async def messages_stream(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming call to POST /v1/messages (``stream: true``).

        Yields parsed content-block SSE events as dicts.
        """
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/messages"
        body["stream"] = True

        async for event in self.stream_sse(url, headers, body):
            yield event

    async def count_tokens(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> ProviderResponse:
        """Call POST /v1/messages/count_tokens (token estimation endpoint)."""
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/messages/count_tokens"
        return await self.request_json("POST", url, headers, body)
