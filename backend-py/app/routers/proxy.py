"""
Proxy routes — /v1/messages (Anthropic) and /v1/chat/completions (OpenAI).
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.adapters import base as adapter_base
from app.providers import resolver as provider_resolver

router = APIRouter()


@router.post("/v1/messages")
async def anthropic_messages(request: Request):
    """Anthropic Messages API proxy."""
    body = await request.json()
    model = body.get("model", "claude-sonnet-4-7")

    provider = provider_resolver.resolve(model)
    if not provider:
        return {"error": "No provider available for model", "model": model}

    cfg = _get_provider_config(provider)
    if not cfg.get("api_key"):
        return {"error": "API key not configured for provider"}

    target_url = cfg.get("base_url", "").rstrip("/") + "/v1/messages"
    headers = adapter_base.build_headers(cfg["api_key"], {"anthropic-version": "2023-06-01"})

    body["max_tokens"] = body.get("max_tokens", 8192)
    body["stream"] = body.get("stream", True)

    async def generate():
        async with httpx.AsyncClient() as client:
            async for event in adapter_base.stream_sse(client, target_url, headers, body):
                yield f"event: {event.get('type', 'ping')}\ndata: {json.dumps(event)}\n\n"
            yield "event: done\ndata: {}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/v1/chat/completions")
async def openai_chat(request: Request):
    """OpenAI Chat Completions API proxy."""
    body = await request.json()
    model = body.get("model", "gpt-4o")

    provider = provider_resolver.resolve(model)
    if not provider:
        return {"error": "No provider available for model", "model": model}

    cfg = _get_provider_config(provider)
    if not cfg.get("api_key"):
        return {"error": "API key not configured for provider"}

    target_url = cfg.get("base_url", "").rstrip("/") + "/chat/completions"
    headers = adapter_base.build_headers(cfg["api_key"])

    body["stream"] = body.get("stream", True)

    async def generate():
        async with httpx.AsyncClient() as client:
            async for chunk in adapter_base.stream_sse(client, target_url, headers, body):
                yield f"data: {json.dumps(chunk)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


def _get_provider_config(provider: dict[str, Any]) -> dict[str, Any]:
    """Resolve a provider's runtime config."""
    from app.config import settings
    cfg = settings.config.get(provider["name"], {})
    return {
        "api_key": cfg.get("apiKey", ""),
        "base_url": cfg.get("baseUrl", provider.get("default_base_url", "")),
    }
