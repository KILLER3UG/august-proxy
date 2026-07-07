"""OpenAI Chat Completions / Responses API client.

Covers all providers that use OpenAI-compatible API formats (``api_mode:
openai_chat`` or ``codex_responses``). This includes ~22 providers such as
DeepSeek, OpenRouter, Novita, Nvidia, xAI, Together, OpenCode, and more.

Port of the HTTP transport portions of backend/adapters/openai.js.
"""
from __future__ import annotations
from typing import AsyncIterator
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
        """Resolve the base URL for OpenAI-compatible APIs.

        Defaults to ``https://api.openai.com/v1``.
        """
        base = super().resolveBaseUrl()
        if not base:
            base = 'https://api.openai.com/v1'
        return base.rstrip('/')

    async def chatCompletions(self, body: dict[str, object], apiKey: str | None=None) -> ProviderResponse:
        """Non-streaming call to POST /chat/completions."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = f'{self.resolveBaseUrl()}/chat/completions'
        body['stream'] = False
        return await self.requestJson('POST', url, headers, body)

    async def chatCompletionsStream(self, body: dict[str, object], apiKey: str | None=None) -> AsyncIterator[dict[str, object]]:
        """Streaming call to POST /chat/completions (``stream: true``).

        Yields raw SSE ``data:`` chunks as parsed dicts.
        """
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = f'{self.resolveBaseUrl()}/chat/completions'
        body['stream'] = True
        async for event in self.streamSse(url, headers, body):
            yield event

    async def responses(self, body: dict[str, object], apiKey: str | None=None) -> ProviderResponse:
        """Call to POST /v1/responses (OpenAI Responses API).

        OpenAI's newer Responses API is a non-streaming endpoint.
        """
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = f'{self.resolveBaseUrl()}/responses'
        return await self.requestJson('POST', url, headers, body)

    async def listModels(self, apiKey: str | None=None) -> ProviderResponse:
        """Call GET /v1/models to list available models."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = f'{self.resolveBaseUrl()}/models'
        return await self.requestJson('GET', url, headers)