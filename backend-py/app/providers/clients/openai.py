"""OpenAI Chat Completions / Responses API client.

Covers all providers that use OpenAI-compatible API formats (``api_mode:
openai_chat`` or ``codex_responses``). This includes ~22 providers such as
DeepSeek, OpenRouter, Novita, Nvidia, xAI, Together, OpenCode, and more.

Port of the HTTP transport portions of backend/adapters/openai.js.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from app.providers.clients.base import BaseProviderClient, ProviderResponse


class OpenAIClient(BaseProviderClient):
    """Client for OpenAI Chat Completions and Responses APIs."""

    api_format = "openai_chat"

    def build_auth_headers(self, api_key: str | None) -> dict[str, str]:
        """Build headers for OpenAI-compatible APIs.

        Most OpenAI-compatible providers just need the standard
        ``Authorization: Bearer <key>`` header.
        """
        headers = super().build_auth_headers(api_key)
        # OpenAI-specific headers that some providers expect
        extra = self.config.get("default_headers")
        if isinstance(extra, dict):
            headers.update(extra)
        return headers

    def resolve_base_url(self) -> str:
        """Resolve the base URL for OpenAI-compatible APIs.

        Defaults to ``https://api.openai.com/v1``.
        """
        base = super().resolve_base_url()
        if not base:
            base = "https://api.openai.com/v1"
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
        """Streaming call to POST /chat/completions (``stream: true``).

        Yields raw SSE ``data:`` chunks as parsed dicts.
        """
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/chat/completions"
        body["stream"] = True

        async for event in self.stream_sse(url, headers, body):
            yield event

    async def responses(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> ProviderResponse:
        """Call to POST /v1/responses (OpenAI Responses API).

        OpenAI's newer Responses API is a non-streaming endpoint.
        """
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/responses"
        return await self.request_json("POST", url, headers, body)

    async def list_models(
        self,
        api_key: str | None = None,
    ) -> ProviderResponse:
        """Call GET /v1/models to list available models."""
        if api_key is None:
            api_key = self.resolve_api_key()
        headers = self.build_auth_headers(api_key)
        url = f"{self.resolve_base_url()}/models"
        return await self.request_json("GET", url, headers)
