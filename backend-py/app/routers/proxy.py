"""
Proxy routes — /v1/messages (Anthropic) and /v1/chat/completions (OpenAI).

Now delegates to the full adapter implementations for message translation,
tool call interception, and SSE streaming.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.adapters import anthropic as anthropic_adapter
from app.adapters import openai as openai_adapter
from app.providers import resolver as provider_resolver

router = APIRouter()


@router.post("/v1/messages")
async def anthropic_messages(request: Request):
    """Anthropic Messages API proxy.

    Delegates to the Anthropic adapter which handles:
    - Model alias resolution
    - System prompt normalization
    - Message format translation (Anthropic ↔ OpenAI)
    - SSE streaming (native and converted)
    - Tool call interception and managed execution
    """
    body = await request.json()
    result, headers = await anthropic_adapter.handle_messages(body, request)

    if isinstance(result, dict):
        if "error" in result:
            return result
        return result

    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            result,
            media_type="text/event-stream",
            headers=headers or {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return result


@router.post("/v1/chat/completions")
async def openai_chat(request: Request):
    """OpenAI Chat Completions API proxy.

    Delegates to the OpenAI adapter which handles:
    - Provider resolution for any model
    - SSE streaming with tool call interception
    - Multi-round tool resolution
    - Session derivation
    """
    body = await request.json()
    result, headers = await openai_adapter.handle_chat_completions(body, request)

    if isinstance(result, dict):
        if "error" in result:
            return result
        return result

    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            result,
            media_type="text/event-stream",
            headers=headers or {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return result


@router.post("/v1/responses")
async def openai_responses(request: Request):
    """OpenAI Responses API proxy.

    Translates the chat completion response to the Responses API format.
    Uses the same OpenAI adapter as /v1/chat/completions.
    """
    body = await request.json()
    body["_endpoint"] = "responses"
    result, headers = await openai_adapter.handle_chat_completions(body, request)

    if isinstance(result, dict):
        if "error" in result:
            return result
        return _translate_to_responses_format(result)

    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            result,
            media_type="text/event-stream",
            headers=headers or {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return result


def _translate_to_responses_format(chat_completion: dict) -> dict:
    """Translate a Chat Completions response to Responses API format."""
    import uuid
    import time

    choices = chat_completion.get("choices", [])
    choice = choices[0] if choices else {}
    message = choice.get("message", {})
    finish_reason = choice.get("finish_reason", "stop")
    usage = chat_completion.get("usage", {})

    output_items = []

    # Reasoning
    reasoning = message.get("reasoning") or message.get("reasoning_content", "")
    if reasoning:
        output_items.append({
            "id": f"item_{uuid.uuid4().hex[:8]}",
            "type": "reasoning",
            "status": "completed",
            "content": reasoning,
        })

    # Tool calls
    for tc in message.get("tool_calls", []):
        output_items.append({
            "id": tc.get("id", f"call_{uuid.uuid4().hex[:8]}"),
            "type": "function_call",
            "status": "completed",
            "name": tc.get("function", {}).get("name", ""),
            "arguments": tc.get("function", {}).get("arguments", ""),
            "call_id": tc.get("id", ""),
        })

    # Text content
    content = message.get("content", "")
    if content:
        output_items.append({
            "id": f"msg_{uuid.uuid4().hex[:8]}",
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{"type": "output_text", "text": content}],
        })

    return {
        "id": f"resp_{uuid.uuid4().hex[:12]}",
        "object": "response",
        "created_at": int(time.time()),
        "status": "completed",
        "model": chat_completion.get("model", ""),
        "output": output_items,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
        },
    }
async def list_models():
    """List available models from all configured providers."""
    providers = provider_resolver.list_available()
    models = []
    for p in providers:
        name = p.get("name", "")
        model_profiles = p.get("model_profiles", {})
        for model_id, profile in model_profiles.items():
            if model_id == "*":
                continue
            models.append({
                "id": model_id,
                "provider": name,
                "object": "model",
                "context_window": profile.get("contextWindow", 0),
                "max_output_tokens": profile.get("maxOutputTokens", 0),
            })

    return {"object": "list", "data": models}
