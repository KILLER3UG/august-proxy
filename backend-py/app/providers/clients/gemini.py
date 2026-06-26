"""Google AI Studio (Gemini) API client.

Uses the OpenAI-compatible endpoint at
``https://generativelanguage.googleapis.com/v1beta/openai/``.

Auth is via the ``x-goog-api-key`` header (not Bearer token).
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from app.providers.clients.base import BaseProviderClient, ProviderResponse


class GeminiClient(BaseProviderClient):
    """Client for Google AI Studio's OpenAI-compatible endpoint."""

    api_format = "gemini_openai"

    def build_auth_headers(self, api_key: str | None) -> dict[str, str]:
        """Build headers for Google AI Studio.

        Uses ``x-goog-api-key`` instead of ``Authorization: Bearer``.
        """
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if api_key:
            headers["x-goog-api-key"] = api_key
        return headers

    def resolve_base_url(self) -> str:
        base = super().resolve_base_url()
        if not base:
            base = "https://generativelanguage.googleapis.com/v1beta/openai"
        return base.rstrip("/")

    async def chat_completions(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> ProviderResponse:
        """Non-streaming call to POST /chat/completions."""
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/chat/completions"
        body["stream"] = False
        return await self.request_json("POST", url, headers, body)

    async def chat_completions_stream(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming call to POST /chat/completions."""
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/chat/completions"
        body["stream"] = True

        async for event in self.stream_sse(url, headers, body):
            yield event
