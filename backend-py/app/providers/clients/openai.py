"""OpenAI Chat Completions / Responses API client.

Covers all providers that use OpenAI-compatible API formats (``api_mode:
openai_chat`` or ``openai_responses``). This includes ~22 providers such as
DeepSeek, OpenRouter, Novita, Nvidia, xAI, Together, OpenCode, and more.

Port of the HTTP transport portions of backend/adapters/openai.js.
"""

from __future__ import annotations

from typing import AsyncIterator

from app.providers.api_format import join_provider_url, normalize_provider_base_url
from app.providers.clients.base import BaseProviderClient, ProviderResponse


class OpenAIClient(BaseProviderClient):
    """Client for OpenAI Chat Completions and Responses APIs."""

    apiFormat = 'openaiChat'

    def buildAuthHeaders(self, apiKey: str | None) -> dict[str, str]:
        """Build headers for OpenAI-compatible APIs.

        Most OpenAI-compatible providers just need the standard
        ``Authorization: Bearer <key>`` header.
        """
        headers = super().buildAuthHeaders(apiKey)
        extra = self.config.get('defaultHeaders')
        if isinstance(extra, dict):
            headers.update(extra)
        return headers

    def resolveBaseUrl(self) -> str:
        """Host+prefix only — format appends ``/chat/completions`` etc."""
        base = super().resolveBaseUrl()
        if not base:
            base = 'https://api.openai.com/v1'
        return normalize_provider_base_url(base)

    def _endpoint(self, *parts: str) -> str:
        return join_provider_url(self.resolveBaseUrl(), *parts)

    async def chat_completions(self, body: dict[str, object], apiKey: str | None = None) -> ProviderResponse:
        """Non-streaming call to POST /chat/completions."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = self._endpoint('chat', 'completions')
        body['stream'] = False
        return await self.requestJson('POST', url, headers, body)

    async def chat_completions_stream(
        self, body: dict[str, object], apiKey: str | None = None
    ) -> AsyncIterator[dict[str, object]]:
        """Streaming call to POST /chat/completions (``stream: true``).

        Yields raw SSE ``data:`` chunks as parsed dicts.
        """
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = self._endpoint('chat', 'completions')
        body['stream'] = True
        async for event in self.streamSse(url, headers, body):
            yield event

    async def responses(self, body: dict[str, object], apiKey: str | None = None) -> ProviderResponse:
        """Call to POST /responses (OpenAI Responses API)."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = self._endpoint('responses')
        return await self.requestJson('POST', url, headers, body)

    async def listModels(self, apiKey: str | None = None) -> ProviderResponse:
        """Call GET /models to list available models."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = self._endpoint('models')
        return await self.requestJson('GET', url, headers)
