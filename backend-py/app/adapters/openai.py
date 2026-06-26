"""
OpenAI Chat Completions adapter — message translation, SSE passthrough,
and managed tool execution for the /v1/chat/completions endpoint.

Port of backend/adapters/openai.js (1,494 lines).

Key responsibilities:
- Session derivation from request body / headers
- Provider profile resolution and merging
- SSE streaming to the client (native or simulated)
- Tool call interception and managed execution
- Multi-round tool resolution loop
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, AsyncIterator, Callable

from app.adapters.base import stream_sse, build_headers
from app.adapters.proxy_tools import (
    get_proxy_openai_tool_definitions,
    append_missing_openai_tools,
    get_canonical_managed_openai_web_tools,
    format_managed_tool_result,
    execute_managed_proxy_tool,
    execute_managed_openai_tool_calls,
    get_tool_definition_name,
    is_proxy_managed_local_tool_name,
)
from app.adapters.tool_classification import (
    classify_openai_tool_calls,
    get_tool_name_from_openai_tool,
)
from app.providers import resolver as provider_resolver
from app.providers.clients import get_client

# ── Constants ─────────────────────────────────────────────────────────

MAX_MANAGED_TOOL_ROUNDS = 10


# ── Session derivation ────────────────────────────────────────────────


def derive_session_id_from_openai(
    body: dict[str, Any] | None,
    request: Any | None = None,
) -> str:
    """Extract a session identifier from an OpenAI Chat Completions body.

    Order: explicit sessionId → user field → metadata.sessionId → headers → ''.
    """
    if body and isinstance(body, dict):
        from_body = (
            body.get("sessionId")
            or body.get("session_id")
            or body.get("metadata", {}).get("sessionId")
            or body.get("metadata", {}).get("session_id")
            or body.get("user")
        )
        if from_body:
            return str(from_body)

    if request and hasattr(request, "headers"):
        header_keys = [
            "x-session-id",
            "x-conversation-id",
            "x-claude-code-session-id",
            "x-request-id",
            "x-correlation-id",
        ]
        for key in header_keys:
            value = request.headers.get(key)
            if value:
                return str(value)

    return ""


def derive_model_inheritance_session_id(body: dict[str, Any] | None, request: Any | None = None) -> str:
    """Extract session ID specifically for model inheritance lookups."""
    if body and isinstance(body, dict):
        from_body = (
            body.get("sessionId")
            or body.get("session_id")
            or body.get("metadata", {}).get("sessionId")
            or body.get("metadata", {}).get("session_id")
        )
        if from_body:
            return str(from_body)
    if request and hasattr(request, "headers"):
        for key in ["x-session-id", "x-conversation-id", "x-claude-code-session-id"]:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ""


def extract_request_headers(request: Any) -> dict[str, str]:
    """Safely extract relevant request headers into a plain dict."""
    if not request or not hasattr(request, "headers"):
        return {}
    out: dict[str, str] = {}
    keys = [
        "x-session-id", "x-conversation-id", "x-request-id",
        "x-correlation-id", "user-agent", "x-august-client",
    ]
    for key in keys:
        value = request.headers.get(key)
        if value:
            out[key] = str(value)
    return out


# ── Profile / provider resolution ────────────────────────────────────


def get_openai_compatible_profile(
    provider_name: str | None,
    model: str,
) -> dict[str, Any] | None:
    """Resolve an OpenAI-compatible provider profile for a model."""
    resolved = provider_resolver.resolve(provider_name or model)
    if not resolved:
        return None

    # Ensure we have an OpenAI-compatible client
    client = get_client(resolved)
    if client and client.api_format in ("openai_chat", "codex_responses"):
        return resolved
    return None


def merge_openai_compatible_profile(
    profile: dict[str, Any],
    base_url: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    """Merge override values into a provider profile."""
    merged = dict(profile)
    if base_url:
        merged["base_url"] = base_url
    if api_key:
        merged["api_key"] = api_key
    return merged


def to_openai_compatible_target_url(base_url: str) -> str:
    """Ensure the base URL ends with /chat/completions."""
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


# ── SSE writing helpers ───────────────────────────────────────────────


def write_openai_sse_headers() -> dict[str, str]:
    """Return SSE response headers for OpenAI-compatible streaming."""
    return {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }


def write_openai_sse_data(chunk: dict[str, Any]) -> str:
    """Serialize a chunk as SSE data line."""
    return f"data: {json.dumps(chunk)}\n\n"


def write_openai_sse_error(error: str) -> str:
    """Serialize an error as SSE."""
    return write_openai_sse_data({"error": {"message": error}})


def write_openai_sse_done() -> str:
    """Return the terminal SSE event."""
    return "data: [DONE]\n\n"


def send_simulated_openai_stream(response: dict[str, Any]) -> list[str]:
    """Create SSE events from a full JSON response, simulating a stream."""
    events: list[str] = [write_openai_sse_headers()]
    response_id = response.get("id", f"chatcmpl-{uuid.uuid4().hex[:12]}")
    created = response.get("created", int(time.time()))
    model = response.get("model", "unknown")

    choices = response.get("choices", [])
    for choice in choices:
        index = choice.get("index", 0)
        delta = choice.get("delta") or choice.get("message", {})

        events.append(write_openai_sse_data({
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": index,
                "delta": delta,
                "finish_reason": None,
            }],
        }))

        events.append(write_openai_sse_data({
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{
                "index": index,
                "delta": {},
                "finish_reason": choice.get("finish_reason", "stop"),
            }],
        }))

    if response.get("usage"):
        events.append(write_openai_sse_data({
            "id": response_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [],
            "usage": response["usage"],
        }))

    events.append(write_openai_sse_done())
    return events


# ── SSE accumulation (for tool resolution) ────────────────────────────


def create_openai_stream_accumulator() -> dict[str, Any]:
    """Create a state object for accumulating streaming chunks."""
    return {
        "id": "",
        "model": "",
        "created": 0,
        "content": "",
        "reasoning": "",
        "tool_calls": [],
        "finish_reason": None,
        "usage": None,
    }


def accumulate_openai_chunk(
    acc: dict[str, Any],
    chunk: dict[str, Any],
) -> None:
    """Accumulate a streaming chunk into the accumulator state."""
    if chunk.get("id"):
        acc["id"] = chunk["id"]
    if chunk.get("model"):
        acc["model"] = chunk["model"]
    if chunk.get("created"):
        acc["created"] = chunk["created"]
    if chunk.get("usage"):
        acc["usage"] = chunk["usage"]

    choices = chunk.get("choices", [])
    for choice in choices:
        delta = choice.get("delta", {})
        if choice.get("finish_reason"):
            acc["finish_reason"] = choice["finish_reason"]

        if delta.get("content"):
            acc["content"] += delta["content"]
        if delta.get("reasoning") or delta.get("reasoning_content"):
            acc["reasoning"] += delta.get("reasoning", "") or delta.get("reasoning_content", "")
        if delta.get("tool_calls"):
            for tc in delta["tool_calls"]:
                existing = next(
                    (t for t in acc["tool_calls"] if t.get("index") == tc.get("index")),
                    None,
                )
                if existing:
                    if tc.get("id"):
                        existing["id"] = tc["id"]
                    if tc.get("function", {}).get("name"):
                        existing.setdefault("function", {})["name"] = (
                            existing.get("function", {}).get("name", "") + tc["function"]["name"]
                        )
                    if tc.get("function", {}).get("arguments"):
                        existing.setdefault("function", {})["arguments"] = (
                            existing.get("function", {}).get("arguments", "") + tc["function"]["arguments"]
                        )
                else:
                    acc["tool_calls"].append({
                        "index": tc.get("index", 0),
                        "id": tc.get("id", ""),
                        "type": tc.get("type", "function"),
                        "function": {
                            "name": tc.get("function", {}).get("name", ""),
                            "arguments": tc.get("function", {}).get("arguments", ""),
                        },
                    })


def build_openai_aggregated_from_stream(acc: dict[str, Any]) -> dict[str, Any]:
    """Build a complete response dict from accumulated stream data."""
    response_id = acc.get("id") or f"chatcmpl-{uuid.uuid4().hex[:12]}"
    message: dict[str, Any] = {"role": "assistant", "content": acc.get("content", "")}
    if acc.get("reasoning"):
        message["reasoning"] = acc["reasoning"]
    if acc.get("tool_calls"):
        message["tool_calls"] = [
            {
                "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {
                    "name": tc.get("function", {}).get("name", ""),
                    "arguments": tc.get("function", {}).get("arguments", ""),
                },
            }
            for tc in acc["tool_calls"]
        ]

    return {
        "id": response_id,
        "object": "chat.completion",
        "created": acc.get("created") or int(time.time()),
        "model": acc.get("model") or "unknown",
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": acc.get("finish_reason") or "stop",
            }
        ],
        "usage": acc.get("usage") or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


# ── Tool result error detection ──────────────────────────────────────


def is_openai_tool_result_error(tool_message: dict[str, Any]) -> bool:
    """Check if a tool result contains an error pattern."""
    content = tool_message.get("content", "")
    if isinstance(content, str):
        lower = content.lower()
        return (
            "error:" in lower
            or "exit code" in lower
            or "command not found" in lower
            or "no such file" in lower
            or "permission denied" in lower
        )
    return False


async def fallback_client_failed_tools_openai(
    messages: list[dict[str, Any]],
    managed_local_tool_names: set[str],
) -> list[dict[str, Any]]:
    """Detect and retry client-failed managed tools.

    Scans trailing tool messages for error patterns and re-executes
    any managed tools that appear to have failed on the client side.
    """
    if not messages:
        return messages

    updated = list(messages)
    changed = False

    for i in range(len(updated) - 1, -1, -1):
        msg = updated[i]
        if msg.get("role") != "tool":
            break
        if not is_openai_tool_result_error(msg):
            continue

        # Find the corresponding tool call
        tool_call_id = msg.get("tool_call_id", "")
        for j in range(i - 1, -1, -1):
            prev = updated[j]
            if prev.get("role") != "assistant":
                break
            for tc in prev.get("tool_calls", []):
                if tc.get("id") == tool_call_id and tc.get("function", {}).get("name"):
                    name = tc["function"]["name"]
                    if name in managed_local_tool_names:
                        try:
                            args = json.loads(tc["function"].get("arguments", "{}"))
                        except (json.JSONDecodeError, TypeError):
                            args = {}
                        try:
                            result = await execute_managed_proxy_tool(name, args)
                            updated[i] = {
                                "tool_call_id": tool_call_id,
                                "role": "tool",
                                "content": format_managed_tool_result(name, result),
                            }
                            changed = True
                        except Exception as exc:
                            updated[i] = {
                                "tool_call_id": tool_call_id,
                                "role": "tool",
                                "content": f"Fallback error: {exc}",
                            }
                            changed = True
                    break
            break

    return updated if changed else messages


# ── Tool resolution loop (streaming) ──────────────────────────────────


async def resolve_managed_openai_tool_calls(
    messages: list[dict[str, Any]],
    model: str,
    upstream_url: str,
    upstream_headers: dict[str, str],
    known_tools: list[dict[str, Any]],
    managed_local_tool_names: set[str],
    client_tool_names: set[str],
    workspace_path: str | None = None,
    on_tool_event: Callable[[dict[str, Any]], None] | None = None,
    parent_signal: Any = None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Run the multi-round tool resolution loop.

    For each round:
    1. Call upstream with current messages
    2. Classify tool calls
    3. If only managed tools, execute them locally and append results
    4. If client tools are present, return the response for passthrough
    5. Repeat until no managed tools remain or max rounds reached
    """
    current_messages = list(messages)
    final_usage: dict[str, Any] | None = None
    client = None  # Will be set on first iteration

    for _round in range(MAX_MANAGED_TOOL_ROUNDS):
        # Make upstream call
        resp = await _client.request_json(
            "POST", upstream_url, upstream_headers, {
                "model": model,
                "messages": current_messages,
                "tools": known_tools,
                "stream": False,
            }
        )

        if resp.is_error:
            return current_messages, resp.body if isinstance(resp.body, dict) else {"error": str(resp.body)}

        response_body = resp.body_json or {}
        if response_body.get("usage"):
            final_usage = response_body["usage"]

        choices = response_body.get("choices", [])
        if not choices:
            break

        choice = choices[0]
        message = choice.get("message", {})
        finish_reason = choice.get("finish_reason", "stop")

        # Check if there are tool calls
        tool_calls = message.get("tool_calls", [])
        if not tool_calls:
            # No tools — done
            current_messages.append(message)
            break

        # Classify tool calls
        classification = classify_openai_tool_calls(
            tool_calls, managed_local_tool_names, client_tool_names,
        )

        if not classification["has_managed"]:
            # All client tools — done, pass through
            current_messages.append(message)
            break

        # Execute managed tools
        tool_results = await execute_managed_openai_tool_calls(
            classification["managed_tool_calls"],
            known_tools,
            current_messages,
            workspace_path,
            on_tool_event,
            parent_signal,
        )

        current_messages.append(message)
        current_messages.extend(tool_results)

        # If there are also client tools, stop and let the client handle them
        if classification["has_client_or_unknown"]:
            break

    return current_messages, final_usage


# ── Main streaming handler ────────────────────────────────────────────


async def stream_openai_sse_to_client(
    upstream_url: str,
    upstream_headers: dict[str, str],
    body: dict[str, Any],
) -> AsyncIterator[str]:
    """Pipe SSE events directly from upstream to client."""
    yield write_openai_sse_headers()
    body["stream"] = True

    async for event in _client.stream_sse(upstream_url, upstream_headers, body):
        if event.get("type") == "error":
            yield write_openai_sse_error(event.get("body", str(event.get("error", ""))))
            yield write_openai_sse_done()
            return

        if event.get("_event_type"):
            del event["_event_type"]

        yield write_openai_sse_data(event)
        # Check for terminal events
        choices = event.get("choices", [])
        if choices and choices[0].get("finish_reason"):
            if event.get("usage"):
                yield write_openai_sse_data({"choices": [], "usage": event["usage"]})
            yield write_openai_sse_done()
            return

    yield write_openai_sse_done()


async def stream_upstream_and_resolve_tools_openai(
    upstream_url: str,
    upstream_headers: dict[str, str],
    body: dict[str, Any],
    model: str,
    known_tools: list[dict[str, Any]],
    managed_local_tool_names: set[str],
    client_tool_names: set[str],
    workspace_path: str | None = None,
    on_tool_event: Callable[[dict[str, Any]], None] | None = None,
) -> AsyncIterator[str]:
    """Stream from upstream, intercept tool calls, resolve them, and continue.

    This is the key function for handling streaming with managed tool execution.
    """
    yield write_openai_sse_headers()

    acc = create_openai_stream_accumulator()
    tool_round = 0
    current_messages = list(body.get("messages", []))
    response_id = ""
    model_name = model

    # Phase 1: Stream from upstream, accumulate, and detect tool calls
    async for chunk in _client.stream_sse(upstream_url, upstream_headers, {**body, "stream": True}):
        if chunk.get("type") == "error":
            yield write_openai_sse_error(chunk.get("body", str(chunk.get("error", ""))))
            yield write_openai_sse_done()
            return

        accumulate_openai_chunk(acc, chunk)
        yield write_openai_sse_data(chunk)

        # Check if this is the final chunk with tool calls
        choices = chunk.get("choices", [])
        if choices and choices[0].get("finish_reason") in ("tool_calls", "stop"):
            response_id = acc.get("id") or chunk.get("id", "")
            model_name = acc.get("model") or model

            if acc["tool_calls"]:
                # We have tool calls — classify and execute managed ones
                tool_round += 1
                if tool_round > MAX_MANAGED_TOOL_ROUNDS:
                    break

                # Build assistant message from accumulated data
                assistant_msg = {
                    "role": "assistant",
                    "content": acc.get("content", ""),
                }
                if acc["reasoning"]:
                    assistant_msg["reasoning"] = acc["reasoning"]
                if acc["tool_calls"]:
                    assistant_msg["tool_calls"] = [
                        {
                            "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                            "type": "function",
                            "function": {
                                "name": tc.get("function", {}).get("name", ""),
                                "arguments": tc.get("function", {}).get("arguments", ""),
                            },
                        }
                        for tc in acc["tool_calls"]
                    ]

                current_messages.append(assistant_msg)

                classification = classify_openai_tool_calls(
                    acc["tool_calls"], managed_local_tool_names, client_tool_names,
                )

                if classification["has_managed"] and (classification["can_execute_managed"] or tool_round < MAX_MANAGED_TOOL_ROUNDS):
                    # Execute managed tools
                    tool_results = await execute_managed_openai_tool_calls(
                        classification["managed_tool_calls"],
                        known_tools,
                        current_messages,
                        workspace_path,
                        on_tool_event,
                    )
                    current_messages.extend(tool_results)

                    # Re-call upstream with tool results appended
                    acc = create_openai_stream_accumulator()

                    async for next_chunk in _client.stream_sse(
                        upstream_url, upstream_headers,
                        {"model": model, "messages": current_messages, "tools": known_tools, "stream": True},
                    ):
                        if next_chunk.get("type") == "error":
                            yield write_openai_sse_error(next_chunk.get("body", ""))
                            yield write_openai_sse_done()
                            return
                        accumulate_openai_chunk(acc, next_chunk)
                        yield write_openai_sse_data(next_chunk)

                        nchoices = next_chunk.get("choices", [])
                        if nchoices and nchoices[0].get("finish_reason"):
                            break

                    current_messages.append({
                        "role": "assistant",
                        "content": acc.get("content", ""),
                        **({"tool_calls": acc["tool_calls"]} if acc["tool_calls"] else {}),
                    })
                    if acc["usage"]:
                        yield write_openai_sse_data({"choices": [], "usage": acc["usage"]})

            yield write_openai_sse_done()
            return

    yield write_openai_sse_done()


# ── Main entry point ──────────────────────────────────────────────────


async def handle_chat_completions(
    body: dict[str, Any],
    request: Any = None,
) -> tuple[dict[str, Any] | AsyncIterator[str], dict[str, str] | None]:
    """Handle a /v1/chat/completions or /v1/responses request.

    Returns a tuple of (response_or_stream, response_headers).
    """
    model = body.get("model", "gpt-4o")
    provider = provider_resolver.resolve(model)
    if not provider:
        return {"error": "No provider available for model", "model": model}, None

    # Get client and config
    client = get_client(provider)
    if not client:
        return {"error": f"No client for provider: {provider.get('name')}"}, None

    api_key = client.resolve_api_key()
    if not api_key:
        return {"error": "API key not configured for provider"}, None

    headers = client.build_auth_headers(api_key)
    base_url = client.resolve_base_url()
    upstream_url = to_openai_compatible_target_url(base_url)

    client_wants_stream = body.get("stream", False)
    is_responses_endpoint = body.get("_endpoint") == "responses"

    # Derive session
    session_id = derive_session_id_from_openai(body, request)

    # Resolve tool definitions
    known_tools = get_proxy_openai_tool_definitions()
    client_tools = body.get("tools", [])
    if client_tools:
        append_missing_openai_tools(known_tools, client_tools)

    managed_local_tool_names: set[str] = set()
    client_tool_names: set[str] = {get_tool_definition_name(t) for t in (client_tools or []) if t}

    # Determine if we have managed tools to intercept
    has_managed_tools = any(
        is_proxy_managed_local_tool_name(get_tool_definition_name(t))
        for t in known_tools
    )

    # Routing: stream or non-stream
    if is_responses_endpoint:
        # Responses API — force non-streaming, translate response
        body["stream"] = False
        resp = await client.request_json("POST", upstream_url.replace("/chat/completions", "/responses"), headers, body)
        return resp.body if isinstance(resp.body, (dict, list)) else {"response": str(resp.body)}, None

    if client_wants_stream:
        # Streaming path
        if has_managed_tools:
            stream = stream_upstream_and_resolve_tools_openai(
                upstream_url, headers, body, model,
                known_tools, managed_local_tool_names, client_tool_names,
            )
        else:
            stream = stream_openai_sse_to_client(upstream_url, headers, body)
        return stream, write_openai_sse_headers()
    else:
        # Non-streaming path
        body["stream"] = False
        if has_managed_tools:
            messages = body.get("messages", [])
            updated_messages, usage = await resolve_managed_openai_tool_calls(
                messages, model, upstream_url, headers,
                known_tools, managed_local_tool_names, client_tool_names,
            )
            # Build final response
            last_msg = updated_messages[-1] if updated_messages else {}
            response = build_openai_aggregated_from_stream({
                "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
                "model": model,
                "created": int(time.time()),
                "content": last_msg.get("content", ""),
                "tool_calls": last_msg.get("tool_calls", []),
                "finish_reason": "stop" if not last_msg.get("tool_calls") else "tool_calls",
                "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            })
            return response, None
        else:
            resp = await client.request_json("POST", upstream_url, headers, body)
            return resp.body if isinstance(resp.body, (dict, list)) else {"response": str(resp.body)}, None


# ── Lazy client reference ─────────────────────────────────────────────

_client = None


def _get_client() -> Any:
    global _client
    if _client is None:
        from app.providers.clients.openai import OpenAIClient
        _client = OpenAIClient({})
    return _client
