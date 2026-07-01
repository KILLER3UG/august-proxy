"""Google AI Studio (Gemini) API client.

Uses the OpenAI-compatible endpoint at
``https://generativelanguage.googleapis.com/v1beta/openai/``.

Auth is via the ``x-goog-api-key`` header (not Bearer token).
"""
from __future__ import annotations
from typing import AsyncIterator
from app.providers.clients.base import BaseProviderClient, ProviderResponse

class GeminiClient(BaseProviderClient):
    """Client for Google AI Studio's OpenAI-compatible endpoint."""
    apiFormat = 'gemini_openai'

    def buildAuthHeaders(self, apiKey: str | None) -> dict[str, str]:
        """Build headers for Google AI Studio.

        Uses ``x-goog-api-key`` instead of ``Authorization: Bearer``.
        """
        headers: dict[str, str] = {'Content-Type': 'application/json'}
        if apiKey:
            headers['x-goog-api-key'] = apiKey
        return headers

    def resolveBaseUrl(self) -> str:
        base = super().resolveBaseUrl()
        if not base:
            base = 'https://generativelanguage.googleapis.com/v1beta/openai'
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
        """Streaming call to POST /chat/completions."""
        if apiKey is None:
            apiKey = self.resolveApiKey()
        headers = self.buildAuthHeaders(apiKey)
        url = f'{self.resolveBaseUrl()}/chat/completions'
        body['stream'] = True
        async for event in self.streamSse(url, headers, body):
            yield event