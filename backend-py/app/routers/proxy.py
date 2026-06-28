"""
Proxy routes — /v1/messages (Anthropic) and /v1/chat/completions (OpenAI).

Now delegates to the full adapter implementations for message translation,
tool call interception, and SSE streaming. Also wires traffic/activity
capture into the logger so the Observability section has live data:
start_request on entry, capture_request for the body, and either
end_request (non-streaming) or a stream-wrapping end_request (streaming).
"""

from __future__ import annotations

import time
from typing import Any, AsyncIterator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.adapters import anthropic as anthropic_adapter
from app.adapters import openai as openai_adapter
from app.providers import resolver as provider_resolver
from app.services import logger as traffic_logger

router = APIRouter()


def _client_type_for(endpoint: str) -> str:
    """Map a proxy endpoint to the clientType the UI groups by."""
    if endpoint == "messages":
        return "anthropic"
    if endpoint == "responses":
        return "openai-responses"
    return "openai"


def _safe_int(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


async def _track_request(endpoint: str, body: dict[str, Any], request: Request):
    """Register a pending request and capture its body for observability.

    Returns the request id. The caller MUST call end_request (or wrap the
    stream) so the entry is finalized — otherwise it lingers in pending
    until the stale-cleanup sweep.
    """
    model = body.get("model", "unknown")
    req_id = traffic_logger.start_request({
        "model": model,
        "provider": model,  # adapter resolves the real provider; left for context
        "clientType": _client_type_for(endpoint),
        "endpoint": f"/v1/{endpoint}",
        "method": request.method if hasattr(request, "method") else "POST",
        "path": f"/v1/{endpoint}",
        "sessionId": body.get("sessionId") or body.get("session_id") or "",
    })
    traffic_logger.capture_request(req_id, body)
    traffic_logger.log_activity(
        "request_start",
        f"{_client_type_for(endpoint)} /v1/{endpoint} → {model}",
    )
    return req_id


def _end_non_stream(req_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """Finalize a non-streaming request: capture response/tokens, end it."""
    if "error" in result:
        traffic_logger.capture_error(req_id, str(result.get("error"))[:500])
        traffic_logger.capture_response(req_id, result)
        traffic_logger.end_request(req_id, {"error": str(result.get("error"))})
        traffic_logger.log_activity("request_error", f"[{req_id}] {result.get('error')}")
        return result
    traffic_logger.capture_response(req_id, result)
    usage = result.get("usage") or {}
    in_t = _safe_int(usage.get("prompt_tokens") or usage.get("input_tokens"))
    out_t = _safe_int(usage.get("completion_tokens") or usage.get("output_tokens"))
    if in_t or out_t:
        traffic_logger.capture_tokens(req_id, in_t, out_t)
    traffic_logger.end_request(req_id, {"usage": usage})
    traffic_logger.log_activity(
        "request_complete",
        f"[{req_id}] {_client_type_for('')} ok ({in_t + out_t} tok)",
    )
    return result


async def _wrap_stream(req_id: str, stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """Wrap an SSE stream so completion finalizes the request entry.

    Accumulates a lightweight usage snapshot from any `message_delta` /
    `usage` events that carry token counts, then calls end_request when the
    stream is exhausted or the client disconnects.
    """
    in_t = 0
    out_t = 0
    try:
        async for chunk in stream:
            # Try to harvest usage from streaming chunks without parsing the
            # whole SSE body — best-effort, never blocks the stream.
            try:
                if isinstance(chunk, str):
                    lower = chunk
                    if '"usage"' in lower or '"message_delta"' in lower:
                        import re
                        m_in = re.search(r'"input_tokens"[:\s]+(\d+)', lower)
                        m_out = re.search(r'"output_tokens"[:\s]+(\d+)', lower)
                        if m_in:
                            in_t = max(in_t, int(m_in.group(1)))
                        if m_out:
                            out_t = max(out_t, int(m_out.group(1)))
            except Exception:
                pass
            yield chunk
    except Exception as exc:  # stream error mid-flight
        traffic_logger.capture_error(req_id, str(exc)[:500])
        traffic_logger.end_request(req_id, {"error": str(exc)})
        traffic_logger.log_activity("request_error", f"[{req_id}] stream error: {exc}")
        raise
    else:
        if in_t or out_t:
            traffic_logger.capture_tokens(req_id, in_t, out_t)
        traffic_logger.end_request(req_id, {"usage": {"input_tokens": in_t, "output_tokens": out_t}})
        traffic_logger.log_activity(
            "request_complete",
            f"[{req_id}] stream ok ({in_t + out_t} tok)",
        )
    finally:
        # No-op: end_request already called above; kept for clarity.
        pass


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
    req_id = await _track_request("messages", body, request)
    result, headers = await anthropic_adapter.handle_messages(body, request)

    if isinstance(result, dict):
        return _end_non_stream(req_id, result)

    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            _wrap_stream(req_id, result),
            media_type="text/event-stream",
            headers=headers or {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Unknown shape — finalize as completed with no usage.
    traffic_logger.end_request(req_id, {})
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
    req_id = await _track_request("chat/completions", body, request)
    result, headers = await openai_adapter.handle_chat_completions(body, request)

    if isinstance(result, dict):
        return _end_non_stream(req_id, result)

    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            _wrap_stream(req_id, result),
            media_type="text/event-stream",
            headers=headers or {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    traffic_logger.end_request(req_id, {})
    return result


@router.post("/v1/responses")
async def openai_responses(request: Request):
    """OpenAI Responses API proxy.

    Translates the chat completion response to the Responses API format.
    Uses the same OpenAI adapter as /v1/chat/completions.
    """
    body = await request.json()
    body["_endpoint"] = "responses"
    req_id = await _track_request("responses", body, request)
    result, headers = await openai_adapter.handle_chat_completions(body, request)

    if isinstance(result, dict):
        if "error" in result:
            return _end_non_stream(req_id, result)
        translated = _translate_to_responses_format(result)
        # Re-capture the translated usage so end_request sees correct tokens.
        return _end_non_stream(req_id, translated)

    if isinstance(result, AsyncIterator):
        return StreamingResponse(
            _wrap_stream(req_id, result),
            media_type="text/event-stream",
            headers=headers or {
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    traffic_logger.end_request(req_id, {})
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


@router.get("/v1/models")
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
