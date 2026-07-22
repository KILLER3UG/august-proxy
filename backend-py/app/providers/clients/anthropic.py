"""Anthropic Messages API client.

Port of the HTTP transport portions of backend/adapters/anthropic.js.

Handles:
- POST /v1/messages (streaming and non-streaming)
- Anthropic-specific headers (``anthropic-version``)
- Content-block SSE event parsing
"""

from __future__ import annotations

from typing import AsyncIterator

from app.json_narrowing import as_str
from app.providers.api_format import anthropic_host_base, join_provider_url
from app.providers.clients.base import BaseProviderClient, ProviderResponse


class AnthropicClient(BaseProviderClient):
    """Client for the Anthropic Messages API (``api_mode: anthropic_messages``)."""

    apiFormat = 'anthropicMessages'

    def buildAuthHeaders(self, apiKey: str | None) -> dict[str, str]:
        """Build headers for the Anthropic API.

        Includes the required ``anthropic-version`` header and optional
        ``anthropic-beta`` headers from provider config.
        """
        headers = super().buildAuthHeaders(apiKey)
        headers.setdefault('anthropic-version', '2023-06-01')
        beta = as_str(self.config.get('anthropic_beta'))
        if beta:
            headers['anthropic-beta'] = beta
        return headers

    def resolveBaseUrl(self) -> str:
        """Host only — format leaf adds ``v1/messages`` (never double ``/v1``)."""
        return anthropic_host_base(super().resolveBaseUrl() or 'https://api.anthropic.com')

    def _endpoint(self, *parts: str) -> str:
        return join_provider_url(self.resolveBaseUrl(), *parts)

    async def messages(self, body: dict[str, object], apiKey: str | None = None) -> ProviderResponse:
        """Non-streaming call to POST …/v1/messages."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = self._endpoint('v1', 'messages')
        return await self.requestJson('POST', url, headers, body)

    async def generate(self, prompt: str, system: str | None = None) -> str:
        """v2: Anthropic-specific generate using the messages API."""
        body: dict[str, object] = {
            'model': self.config.get('model', ''),
            'max_tokens': 2048,
            'messages': [{'role': 'user', 'content': prompt}],
        }
        if system:
            body['system'] = system
        try:
            resp = await self.messages(body)
        except (AttributeError, TypeError):
            return ''
        if resp.status != 200:
            return ''
        bodyData = resp.body if isinstance(resp.body, dict) else {}
        content = bodyData.get('content', [])
        if isinstance(content, list) and content:
            block = content[0]
            if isinstance(block, dict):
                return block.get('text', '')
        return ''

    async def messages_stream(
        self, body: dict[str, object], apiKey: str | None = None
    ) -> AsyncIterator[dict[str, object]]:
        """Streaming call to POST /v1/messages (``stream: true``).

        Yields parsed content-block SSE events as dicts.
        """
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = self._endpoint('v1', 'messages')
        body['stream'] = True
        async for event in self.streamSse(url, headers, body):
            yield event

    async def countTokens(self, body: dict[str, object], apiKey: str | None = None) -> ProviderResponse:
        """Call POST …/v1/messages/count_tokens (token estimation endpoint)."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = self._endpoint('v1', 'messages', 'count_tokens')
        return await self.requestJson('POST', url, headers, body)
