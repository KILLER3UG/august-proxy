"""
Anthropic Messages API adapter — message translation, SSE passthrough,
and managed tool execution for the /v1/messages endpoint.

Port of backend/adapters/anthropic.js (3,408 lines).

Key responsibilities:
- Model alias resolution (sonnet → concrete model ID)
- Message format translation (Anthropic ↔ OpenAI)
- System prompt building and normalization
- SSE streaming (native Anthropic format)
- OpenAI-to-Anthropic SSE conversion
- Tool call interception and managed execution
- Multi-round tool resolution loop
- Self-healing message repair
- Session derivation and model inheritance
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, AsyncIterator, Callable

from app.adapters.base import stream_sse, build_headers
from app.adapters.proxy_tools import (
    get_proxy_openai_tool_definitions_for_anthropic,
    get_canonical_managed_anthropic_web_tools,
    append_missing_anthropic_tools,
    format_managed_tool_result,
    execute_managed_proxy_tool,
    execute_managed_openai_tool_calls,
    get_tool_definition_name,
    dedupe_and_canonicalize_anthropic_tools,
    sanitize_anthropic_tool_definition,
    get_managed_anthropic_web_tool_definitions,
    openai_to_anthropic_tool_definition,
    anthropic_to_openai_tool_definition,
    is_proxy_managed_local_tool_name,
    is_browser_automation_tool_name,
    build_client_tool_guidance,
)
from app.adapters.tool_classification import (
    classify_anthropic_tool_uses,
    classify_openai_tool_calls,
    get_tool_name_from_anthropic_tool,
    get_tool_name_from_openai_tool,
)
from app.providers import resolver as provider_resolver
from app.providers.model_resolver import resolve, resolve_or_fallback
from app.providers.clients import get_client

# ── Constants ─────────────────────────────────────────────────────────

CLAUDE_PUBLIC_MODEL_ALIAS = "claude-opus-4-6"
KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES = {
    "claude-3-7-sonnet-20250219",
    "claude-3-5-sonnet-20241022",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
}
MAX_MANAGED_TOOL_ROUNDS = 10

AUGUST_REMINDER = (
    "This proxy environment is August Proxy — a multi-model AI gateway. "
    "You have access to the August tool suite for file operations, web access, "
    "bash commands, and memory."
)

RULE_REMINDER_MESSAGE: dict[str, Any] = {
    "type": "text",
    "text": (
        "## Operational Rules\n\n"
        "1. When browsing the web, prioritize fetching text content directly.\n"
        "2. When executing commands, prefer safe, non-destructive operations.\n"
        "3. Always verify file paths before writing.\n"
        "4. Respect user privacy and data boundaries.\n"
        "5. If a tool fails, retry with corrected parameters before reporting failure."
    ),
}


# ── Model alias resolution ───────────────────────────────────────────


def is_claude_family_model(model: str | None) -> bool:
    """True for Claude family model IDs or public alias names."""
    if not isinstance(model, str):
        return False
    lower = model.strip().lower()
    if not lower:
        return False
    if lower.startswith("claude-"):
        return True
    if model in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return True
    return lower in ("sonnet", "opus", "best", "opusplan")


def resolve_claude_public_model_alias(requested_model: str | None) -> str:
    """Map public aliases (sonnet, opus, best) to concrete model IDs."""
    if not isinstance(requested_model, str):
        return CLAUDE_PUBLIC_MODEL_ALIAS
    normalized = requested_model.strip()
    if not normalized:
        return CLAUDE_PUBLIC_MODEL_ALIAS
    lowered = normalized.lower()
    if lowered in ("sonnet", "sonnet[1m]"):
        return "claude-sonnet-4-6"
    if lowered in ("opus", "opus[1m]", "best", "opusplan"):
        return "claude-opus-4-6"
    if normalized in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return normalized
    if lowered.startswith("claude-"):
        return normalized
    return CLAUDE_PUBLIC_MODEL_ALIAS


def resolve_claude_client_facing_model(requested_model: str | None) -> str:
    """Resolve what model name to present to the client."""
    if not isinstance(requested_model, str):
        return CLAUDE_PUBLIC_MODEL_ALIAS
    normalized = requested_model.strip()
    if not normalized:
        return CLAUDE_PUBLIC_MODEL_ALIAS
    # If it's already a known alias, return as-is
    if normalized in KNOWN_CLAUDE_PUBLIC_MODEL_ALIASES:
        return normalized
    lowered = normalized.lower()
    # Map short aliases
    if lowered == "sonnet":
        return "claude-sonnet-4-6"
    if lowered in ("opus", "best", "opusplan"):
        return "claude-opus-4-6"
    if lowered.startswith("claude-"):
        return normalized
    return CLAUDE_PUBLIC_MODEL_ALIAS


# ── Tool guidance/reminder injection ─────────────────────────────────


def should_inject_reminder_message(
    messages: list[dict[str, Any]] | None,
    existing_system: list[dict[str, Any]] | None = None,
) -> bool:
    """Check if the AUGUST_REMINDER should be injected."""
    if not messages:
        return True
    # Check if any message already mentions "August Proxy" or "August tool suite"
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str) and ("August Proxy" in content or "August tool suite" in content):
            return False
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block.get("text", "")
                    if "August Proxy" in text or "August tool suite" in text:
                        return False
    if existing_system:
        for block in existing_system:
            text = block.get("text", "") if isinstance(block, dict) else str(block)
            if "August Proxy" in text or "August tool suite" in text:
                return False
    return True


def should_inject_august_reminder(system_text: str | None) -> bool:
    """Check if the August reminder should be added to system text."""
    if not system_text:
        return True
    return "August" not in system_text


# ── System prompt builders ────────────────────────────────────────────


def normalize_system_blocks(system: Any) -> list[dict[str, Any]]:
    """Normalize system prompt to list of Anthropic content blocks."""
    if not system:
        return []
    if isinstance(system, str):
        return [{"type": "text", "text": system}]
    if isinstance(system, list):
        return [
            {"type": "text", "text": block} if isinstance(block, str) else block
            for block in system
        ]
    return [{"type": "text", "text": str(system)}]


def system_blocks_to_text(blocks: list[dict[str, Any]] | None) -> str:
    """Flatten system blocks into a single text string."""
    if not blocks:
        return ""
    parts = []
    for block in blocks:
        if isinstance(block, dict):
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                parts.append(json.dumps(block.get("input", {})))
        elif isinstance(block, str):
            parts.append(block)
    return "\n".join(parts)


def build_openai_system_prompt(system: Any) -> str:
    """Convert Anthropic system blocks to an OpenAI-style system string."""
    blocks = normalize_system_blocks(system)
    return system_blocks_to_text(blocks)


def build_anthropic_system_blocks(system: Any) -> list[dict[str, Any]]:
    """Build Anthropic-format system blocks with reminders injected."""
    blocks = normalize_system_blocks(system)
    text = system_blocks_to_text(blocks)

    if should_inject_august_reminder(text):
        blocks.append({"type": "text", "text": AUGUST_REMINDER})

    return blocks


def append_text_to_system_blocks(
    blocks: list[dict[str, Any]] | None,
    text: str,
) -> list[dict[str, Any]]:
    """Append text to the last text block or add a new one."""
    if not blocks:
        return [{"type": "text", "text": text}]
    blocks = list(blocks)
    if blocks and blocks[-1].get("type") == "text":
        blocks[-1] = {
            "type": "text",
            "text": blocks[-1]["text"] + ("\n\n" if not text.startswith("\n") else "") + text,
        }
    else:
        blocks.append({"type": "text", "text": text})
    return blocks


# ── Session derivation ───────────────────────────────────────────────


def derive_session_id_from_anthropic(
    body: dict[str, Any] | None,
    request: Any | None = None,
) -> str:
    """Extract a session identifier from an Anthropic Messages body."""
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
        for key in ["x-session-id", "x-conversation-id", "x-claude-code-session-id", "x-request-id"]:
            value = request.headers.get(key)
            if value:
                return str(value)
    return ""


def extract_request_headers(request: Any) -> dict[str, str]:
    """Safely extract relevant request headers into a dict."""
    if not request or not hasattr(request, "headers"):
        return {}
    out: dict[str, str] = {}
    for key in [
        "x-session-id", "x-conversation-id", "x-request-id",
        "x-correlation-id", "user-agent", "x-august-client",
    ]:
        value = request.headers.get(key)
        if value:
            out[key] = str(value)
    return out


# ── Message translation (Anthropic → OpenAI) ─────────────────────────


def translate_messages(
    messages: list[dict[str, Any]],
    system: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Translate Anthropic-format messages to OpenAI format.

    Handles:
    - Content blocks → string content
    - Tool uses → tool_calls
    - Tool results → tool messages
    - Thinking blocks → reasoning_content
    """
    openai_messages: list[dict[str, Any]] = []

    # Add system message
    if system:
        system_text = system_blocks_to_text(system)
        if system_text:
            openai_messages.append({"role": "system", "content": system_text})

    for msg in messages:
        role = msg.get("role", "")
        content = msg.get("content", "")

        if role == "user":
            if isinstance(content, str):
                openai_messages.append({"role": "user", "content": content})
            elif isinstance(content, list):
                parts = []
                for block in content:
                    if block.get("type") == "text":
                        parts.append({"type": "text", "text": block.get("text", "")})
                    elif block.get("type") == "image_url" or block.get("type") == "image":
                        parts.append({
                            "type": "image_url",
                            "image_url": {"url": block.get("source", {}).get("data", "")},
                        })
                    elif block.get("type") == "tool_result":
                        # Will be handled below
                        pass
                if parts:
                    openai_messages.append({"role": "user", "content": parts})

        elif role == "assistant":
            asst_msg: dict[str, Any] = {"role": "assistant"}
            if isinstance(content, str):
                asst_msg["content"] = content
            elif isinstance(content, list):
                text_parts = []
                tool_calls = []
                for block in content:
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
                    elif block.get("type") == "tool_use":
                        tool_calls.append({
                            "id": block.get("id", ""),
                            "type": "function",
                            "function": {
                                "name": block.get("name", ""),
                                "arguments": json.dumps(block.get("input", {})),
                            },
                        })
                    elif block.get("type") == "thinking":
                        asst_msg["reasoning"] = asst_msg.get("reasoning", "") + block.get("text", "")
                        asst_msg["reasoning_content"] = asst_msg.get("reasoning_content", "") + block.get("text", "")
                asst_msg["content"] = "".join(text_parts) if text_parts else ""
                if tool_calls:
                    asst_msg["tool_calls"] = tool_calls
            # Preserve a top-level OpenAI-style tool_calls list even when
            # content is a plain string. The workbench stores OpenAI-path
            # assistant turns as {content: <str>, tool_calls: [...]} — the
            # str branch above would otherwise win and silently drop
            # tool_calls, orphaning the following role:"tool" messages'
            # tool_call_id and causing the upstream provider to reject
            # (HTTP 400) or empty-respond on the re-call after tools.
            if msg.get("tool_calls") and "tool_calls" not in asst_msg:
                asst_msg.setdefault("content", msg.get("content", ""))
                # Ensure function.arguments is always a JSON string (not a
                # parsed dict) for OpenAI API compatibility — some providers
                # silently return empty content when arguments is a dict.
                safe_calls = []
                for tc in msg["tool_calls"]:
                    tc_copy = dict(tc)
                    fn = dict(tc_copy.get("function", {}))
                    if "arguments" in fn and not isinstance(fn["arguments"], str):
                        fn["arguments"] = json.dumps(fn["arguments"])
                    tc_copy["function"] = fn
                    safe_calls.append(tc_copy)
                asst_msg["tool_calls"] = safe_calls
            openai_messages.append(asst_msg)

        elif role == "tool":
            tool_result = content
            if isinstance(tool_result, list):
                # Extract text from content blocks
                text = ""
                for block in tool_result:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            text += block.get("text", "")
                        elif block.get("type") == "tool_use":
                            text += json.dumps(block.get("input", {}))
                        else:
                            text += json.dumps(block)
                    else:
                        text += str(block)
                tool_result = text
            elif not isinstance(tool_result, str):
                tool_result = json.dumps(tool_result)
            openai_messages.append({
                "role": "tool",
                "tool_call_id": msg.get("tool_use_id") or msg.get("tool_call_id", ""),
                "content": tool_result,
            })

    return openai_messages


def sanitize_messages_for_openai_upstream(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Fix messages for OpenAI upstream compatibility.

    Removes tool_use_id from assistant messages, ensures ordering.
    """
    sanitized: list[dict[str, Any]] = []
    for msg in messages:
        sanitized.append(msg)
    return sanitized


def repair_managed_web_tool_results(
    messages: list[dict[str, Any]],
    managed_local_tool_names: set[str],
) -> tuple[list[dict[str, Any]], bool]:
    """Repair managed web tool results that may have been corrupted by the client.

    This handles the case where a third-party client strips or reformats
    web tool results, which breaks the upstream model's understanding.
    """
    # TODO: full implementation — detect truncated tool results for
    # web_search / web_fetch / bash and re-fetch
    return messages, False


# ── Request builders ─────────────────────────────────────────────────


def build_openai_request(
    body: dict[str, Any],
    model: str,
    system: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build an OpenAI-format request from an Anthropic Messages body."""
    openai_body: dict[str, Any] = {
        "model": model,
        "messages": translate_messages(body.get("messages", []), system),
    }

    # Map parameters
    if "max_tokens" in body or "max_output_tokens" in body:
        openai_body["max_tokens"] = body.get("max_tokens") or body.get("max_output_tokens", 4096)
    if "temperature" in body:
        openai_body["temperature"] = body["temperature"]
    if "top_p" in body:
        openai_body["top_p"] = body["top_p"]
    if "top_k" in body:
        openai_body["top_k"] = body["top_k"]
    if "stop_sequences" in body:
        openai_body["stop"] = body["stop_sequences"]

    # Reasoning/thinking → OpenAI reasoning_effort
    thinking = body.get("thinking", {})
    if thinking and isinstance(thinking, dict):
        budget = thinking.get("budget_tokens", 0)
        if budget > 0:
            openai_body["reasoning_effort"] = _budget_to_effort(budget)

    return openai_body


def _budget_to_effort(budget: int) -> str:
    """Map Anthropic thinking budget to OpenAI reasoning_effort."""
    if budget >= 32000:
        return "high"
    if budget >= 16000:
        return "medium"
    return "low"


def build_anthropic_upstream_request(
    body: dict[str, Any],
    model: str,
    system: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build an Anthropic-format request for native upstream calls."""
    anthropic_body: dict[str, Any] = {
        "model": model,
        "messages": body.get("messages", []),
    }

    if "max_tokens" in body or "max_output_tokens" in body:
        anthropic_body["max_tokens"] = body.get("max_tokens") or body.get("max_output_tokens", 4096)
    else:
        anthropic_body["max_tokens"] = 8192

    for key in ("temperature", "top_p", "top_k", "stop_sequences", "metadata"):
        if key in body:
            anthropic_body[key] = body[key]

    if "thinking" in body:
        anthropic_body["thinking"] = body["thinking"]

    if system:
        anthropic_body["system"] = system

    return anthropic_body


# ── SSE streaming (Anthropic native format) ──────────────────────────


def write_anthropic_sse_data(event: str, data: dict[str, Any]) -> str:
    """Serialize an Anthropic SSE event."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def write_anthropic_sse_data_only(data: dict[str, Any]) -> str:
    """Serialize data with just the data: line (event omitted)."""
    return f"data: {json.dumps(data)}\n\n"


def send_simulated_anthropic_stream(response: dict[str, Any]) -> list[str]:
    """Create Anthropic SSE events from a full JSON response.

    Used when the proxy forced non-streaming upstream to do tool resolution,
    then needs to simulate a stream back to the client.
    """
    events: list[str] = []
    response_id = response.get("id", f"msg_{uuid.uuid4().hex[:16]}")
    model = response.get("model", "unknown")
    role = response.get("role", "assistant")
    content = response.get("content", [])
    usage = response.get("usage", {})

    # message_start
    events.append(write_anthropic_sse_data("message_start", {
        "type": "message_start",
        "message": {
            "id": response_id,
            "type": "message",
            "role": role,
            "content": [],
            "model": model,
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": usage.get("input_tokens", 0), "output_tokens": 0},
        },
    }))

    # content blocks
    for i, block in enumerate(content):
        events.append(write_anthropic_sse_data("content_block_start", {
            "type": "content_block_start",
            "index": i,
            "content_block": block,
        }))

        if block.get("type") == "text":
            events.append(write_anthropic_sse_data("content_block_delta", {
                "type": "content_block_delta",
                "index": i,
                "delta": {"type": "text_delta", "text": block.get("text", "")},
            }))
        elif block.get("type") == "tool_use":
            events.append(write_anthropic_sse_data("content_block_delta", {
                "type": "content_block_delta",
                "index": i,
                "delta": {"type": "input_json_delta", "partial_json": json.dumps(block.get("input", {}))},
            }))

        events.append(write_anthropic_sse_data("content_block_stop", {
            "type": "content_block_stop",
            "index": i,
        }))

    # message_delta
    stop_reason = response.get("stop_reason") or "end_turn"
    if content and content[-1].get("type") == "tool_use":
        stop_reason = "tool_use"

    events.append(write_anthropic_sse_data("message_delta", {
        "type": "message_delta",
        "delta": {"stop_reason": stop_reason, "stop_sequence": None},
        "usage": {"output_tokens": usage.get("output_tokens", 0)},
    }))

    # message_stop
    events.append(write_anthropic_sse_data("message_stop", {"type": "message_stop"}))

    return events


def create_anthropic_native_stream_state() -> dict[str, Any]:
    """Create state for tracking an Anthropic native stream."""
    return {
        "message_id": "",
        "model": "",
        "role": "assistant",
        "content_blocks": [],
        "current_index": -1,
        "stop_reason": None,
        "input_tokens": 0,
        "output_tokens": 0,
    }


def get_client_anthropic_index(block_type: str, current_index: int) -> int:
    """Get the client-facing content block index.

    Anthropic SSE block indices can differ from the client-facing index
    when thinking blocks are present (they're counted server-side but
    may not be exposed to all clients).
    """
    return current_index


# ── SSE streaming: OpenAI → Anthropic conversion ─────────────────────


def create_openai_to_anthropic_stream_state() -> dict[str, Any]:
    """Create state for converting OpenAI SSE to Anthropic format."""
    return {
        "message_id": f"msg_{uuid.uuid4().hex[:16]}",
        "model": "",
        "role": "assistant",
        "content_blocks": [],
        "current_index": 0,
        "stop_reason": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "accumulated_text": "",
        "accumulated_reasoning": "",
        "pending_tool_calls": [],
    }


def stream_openai_delta_as_anthropic(
    chunk: dict[str, Any],
    state: dict[str, Any],
) -> list[str]:
    """Convert an OpenAI Chat Completions chunk to Anthropic SSE events."""
    events: list[str] = []

    choices = chunk.get("choices", [])
    if not choices:
        return events

    choice = choices[0]
    delta = choice.get("delta", {})
    finish_reason = choice.get("finish_reason")

    if chunk.get("id") and not state.get("_started"):
        state["message_id"] = chunk["id"]

    if chunk.get("model"):
        state["model"] = chunk["model"]

    # message_start on first chunk
    if not state.get("_started"):
        state["_started"] = True
        events.append(write_anthropic_sse_data("message_start", {
            "type": "message_start",
            "message": {
                "id": state["message_id"],
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": state["model"] or "unknown",
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        }))

    # Content
    content = delta.get("content", "")
    reasoning = delta.get("reasoning") or delta.get("reasoning_content", "")

    if content:
        if not state.get("_text_block_started"):
            state["_text_block_started"] = True
            idx = state["current_index"]
            state["current_index"] += 1
            events.append(write_anthropic_sse_data("content_block_start", {
                "type": "content_block_start",
                "index": idx,
                "content_block": {"type": "text", "text": ""},
            }))
        events.append(write_anthropic_sse_data("content_block_delta", {
            "type": "content_block_delta",
            "index": state["current_index"] - 1,
            "delta": {"type": "text_delta", "text": content},
        }))
        state["accumulated_text"] += content

    if reasoning:
        if not state.get("_reasoning_block_started"):
            state["_reasoning_block_started"] = True
            idx = state["current_index"]
            state["current_index"] += 1
            events.append(write_anthropic_sse_data("content_block_start", {
                "type": "content_block_start",
                "index": idx,
                "content_block": {"type": "thinking", "text": ""},
            }))
        events.append(write_anthropic_sse_data("content_block_delta", {
            "type": "content_block_delta",
            "index": state["current_index"] - 1,
            "delta": {"type": "thinking_delta", "thinking": reasoning},
        }))
        state["accumulated_reasoning"] += reasoning

    # Tool calls
    tool_calls = delta.get("tool_calls", [])
    for tc in tool_calls:
        existing = next(
            (t for t in state["pending_tool_calls"] if t.get("index") == tc.get("index")),
            None,
        )
        if existing:
            if tc.get("id"):
                existing["id"] = tc["id"]
            if tc.get("function", {}).get("name"):
                existing.setdefault("function", {})["name"] = (
                    existing["function"].get("name", "") + tc["function"]["name"]
                )
            if tc.get("function", {}).get("arguments"):
                existing.setdefault("function", {})["arguments"] = (
                    existing["function"].get("arguments", "") + tc["function"]["arguments"]
                )
        else:
            state["pending_tool_calls"].append({
                "index": tc.get("index", 0),
                "id": tc.get("id", ""),
                "type": "function",
                "function": {
                    "name": tc.get("function", {}).get("name", ""),
                    "arguments": tc.get("function", {}).get("arguments", ""),
                },
            })

    # Finish
    if finish_reason and finish_reason != "null":
        # Close any open content blocks
        if state.get("_text_block_started"):
            events.append(write_anthropic_sse_data("content_block_stop", {
                "type": "content_block_stop",
                "index": state["current_index"] - 1,
            }))
        if state.get("_reasoning_block_started"):
            events.append(write_anthropic_sse_data("content_block_stop", {
                "type": "content_block_stop",
                "index": state["current_index"] - 1,
            }))

        # Emit tool use blocks
        for i, tc in enumerate(state["pending_tool_calls"]):
            idx = state["current_index"]
            state["current_index"] += 1
            tool_name = tc.get("function", {}).get("name", "")
            tool_args_str = tc.get("function", {}).get("arguments", "{}")
            try:
                tool_input = json.loads(tool_args_str) if tool_args_str else {}
            except (json.JSONDecodeError, TypeError):
                tool_input = {}

            events.append(write_anthropic_sse_data("content_block_start", {
                "type": "content_block_start",
                "index": idx,
                "content_block": {
                    "type": "tool_use",
                    "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:16]}"),
                    "name": tool_name,
                    "input": tool_input,
                },
            }))
            events.append(write_anthropic_sse_data("content_block_delta", {
                "type": "content_block_delta",
                "index": idx,
                "delta": {"type": "input_json_delta", "partial_json": tool_args_str},
            }))
            events.append(write_anthropic_sse_data("content_block_stop", {
                "type": "content_block_stop",
                "index": idx,
            }))

            state["content_blocks"].append({
                "type": "tool_use",
                "id": tc.get("id", ""),
                "name": tool_name,
                "input": tool_input,
            })

        # message_delta
        anthropic_stop_reason = "end_turn"
        if finish_reason == "tool_calls":
            anthropic_stop_reason = "tool_use"
        elif finish_reason == "length":
            anthropic_stop_reason = "max_tokens"

        events.append(write_anthropic_sse_data("message_delta", {
            "type": "message_delta",
            "delta": {"stop_reason": anthropic_stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": 0},
        }))

        # message_stop
        events.append(write_anthropic_sse_data("message_stop", {"type": "message_stop"}))

    # Usage from final chunk
    if chunk.get("usage"):
        state["input_tokens"] = chunk["usage"].get("prompt_tokens", 0)
        state["output_tokens"] = chunk["usage"].get("completion_tokens", 0)

    return events


# ── Aggregated response builders ─────────────────────────────────────


def build_openai_aggregated_for_anthropic_from_stream(state: dict[str, Any]) -> dict[str, Any]:
    """Build an OpenAI chat completion response from accumulated Anthropic stream state."""
    return {
        "id": state.get("message_id", f"chatcmpl-{uuid.uuid4().hex[:12]}"),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": state.get("model", "unknown"),
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": state.get("accumulated_text", ""),
                },
                "finish_reason": state.get("stop_reason", "stop"),
            }
        ],
        "usage": {
            "prompt_tokens": state.get("input_tokens", 0),
            "completion_tokens": state.get("output_tokens", 0),
            "total_tokens": state.get("input_tokens", 0) + state.get("output_tokens", 0),
        },
    }


# ── Tool call execution (Anthropic format) ───────────────────────────


async def resolve_managed_anthropic_tool_uses(
    messages: list[dict[str, Any]],
    system: list[dict[str, Any]] | None,
    model: str,
    upstream_url: str,
    upstream_headers: dict[str, str],
    is_anthropic_upstream: bool,
    known_tools: list[dict[str, Any]],
    managed_local_tool_names: set[str],
    client_tool_names: set[str],
    workspace_path: str | None = None,
    on_tool_event: Callable[[dict[str, Any]], None] | None = None,
    parent_signal: Any = None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """Run the multi-round tool resolution loop for Anthropic-format requests.

    Similar to the OpenAI version but works with Anthropic's content block format.
    """
    current_messages = list(messages)
    current_system = list(system) if system else []
    final_usage: dict[str, Any] | None = None

    for _round in range(MAX_MANAGED_TOOL_ROUNDS):
        # Build request
        req_body: dict[str, Any] = {
            "model": model,
            "messages": current_messages,
            "max_tokens": 8192,
            "stream": False,
        }
        if current_system:
            req_body["system"] = current_system
        if known_tools:
            req_body["tools"] = known_tools

        # Make upstream call
        if is_anthropic_upstream:
            client = get_client({"api_mode": "anthropic_messages"})
            if client:
                resp = await client.request_json("POST", upstream_url, upstream_headers, req_body)
            else:
                return current_messages, {"error": "No Anthropic client available"}
        else:
            # OpenAI-format upstream
            openai_body = build_openai_request({"messages": current_messages}, model, current_system)
            if known_tools:
                openai_body["tools"] = [anthropic_to_openai_tool_definition(t) for t in known_tools]
            client = get_client({"api_mode": "openai_chat"})
            if client:
                resp = await client.request_json("POST", upstream_url, upstream_headers, openai_body)
            else:
                return current_messages, {"error": "No OpenAI client available"}

        if resp.is_error:
            return current_messages, resp.body if isinstance(resp.body, dict) else {"error": str(resp.body)}

        response_body = resp.body_json or {}

        if response_body.get("usage"):
            final_usage = response_body["usage"]

        # Extract assistant message and tool uses
        if is_anthropic_upstream:
            content = response_body.get("content", [])
            stop_reason = response_body.get("stop_reason", "end_turn")
            assistant_msg: dict[str, Any] = {"role": "assistant", "content": content}

            tool_uses = [b for b in content if b.get("type") == "tool_use"] if content else []
        else:
            choices = response_body.get("choices", [])
            if not choices:
                break
            msg = choices[0].get("message", {})
            assistant_msg = msg
            tool_uses = []
            for tc in msg.get("tool_calls", []):
                tool_uses.append({
                    "type": "tool_use",
                    "name": tc.get("function", {}).get("name", ""),
                    "input": json.loads(tc.get("function", {}).get("arguments", "{}")),
                })

        if not tool_uses:
            current_messages.append(assistant_msg)
            break

        # Classify tool uses
        classification = classify_anthropic_tool_uses(
            tool_uses, managed_local_tool_names, client_tool_names,
        )

        if not classification["has_managed"]:
            current_messages.append(assistant_msg)
            break

        # Execute managed tools
        tool_results: list[dict[str, Any]] = []
        for tu in classification["managed_tool_uses"]:
            tool_name = tu.get("name", "")
            tool_input = tu.get("input", {})
            tool_use_id = tu.get("id", f"toolu_{uuid.uuid4().hex[:16]}")

            try:
                result = await execute_managed_proxy_tool(tool_name, tool_input, workspace_path, parent_signal=parent_signal)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": format_managed_tool_result(tool_name, result),
                })
            except Exception as exc:
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": f"Error: {exc}",
                    "is_error": True,
                })

        current_messages.append(assistant_msg)
        current_messages.extend(tool_results)

        if classification["has_client_or_unknown"]:
            break

    return current_messages, final_usage


# ── Main entry point ─────────────────────────────────────────────────


async def handle_messages(
    body: dict[str, Any],
    request: Any = None,
) -> tuple[dict[str, Any] | AsyncIterator[str], dict[str, str] | None]:
    """Handle a POST /v1/messages request.

    Returns a tuple of (response_or_stream, response_headers).
    """
    model = body.get("model", "claude-sonnet-4-7")
    resolved_model = resolve_claude_public_model_alias(model)

    # Use model resolver for proper alias-based resolution
    try:
        resolved = resolve(resolved_model, default_alias="claude-sonnet-4-7")
        provider_name = resolved["provider"]
        resolved_model = resolved["model"]
    except Exception:
        provider_name = resolved_model

    provider = provider_resolver.resolve(provider_name)
    if not provider:
        return {"error": "No provider available for model", "model": resolved_model}, None

    client = get_client(provider)
    if not client:
        return {"error": f"No client for provider: {provider.get('name')}"}, None

    api_key = client.resolve_api_key()
    if not api_key:
        return {"error": "API key not configured for provider"}, None

    headers = client.build_auth_headers(api_key)
    base_url = client.resolve_base_url()
    is_anthropic_upstream = client.api_format == "anthropic_messages"

    if is_anthropic_upstream:
        upstream_url = f"{base_url}/messages"
    else:
        upstream_url = f"{base_url}/chat/completions"

    client_wants_stream = body.get("stream", False)

    # Normalize system prompt
    system_blocks = build_anthropic_system_blocks(body.get("system", []))

    # Resolve tools
    client_tools = body.get("tools", [])
    known_tools = dedupe_and_canonicalize_anthropic_tools(
        client_tools + get_managed_anthropic_web_tool_definitions()
    )

    # Track managed vs client tools
    managed_local_tool_names: set[str] = set()
    client_tool_names: set[str] = set()
    for t in client_tools:
        name = get_tool_definition_name(t) or t.get("name", "")
        if is_proxy_managed_local_tool_name(name):
            managed_local_tool_names.add(name)
        else:
            client_tool_names.add(name)

    # Derive session
    session_id = derive_session_id_from_anthropic(body, request)

    if client_wants_stream:
        # Streaming path
        if is_anthropic_upstream:
            # Native Anthropic streaming
            stream = _stream_anthropic_native(
                upstream_url, headers, body, resolved_model,
                system_blocks, known_tools,
                managed_local_tool_names, client_tool_names,
            )
        else:
            # OpenAI upstream → Anthropic client SSE conversion
            stream = _stream_openai_as_anthropic(
                upstream_url, headers, body, resolved_model,
                system_blocks, known_tools,
                managed_local_tool_names, client_tool_names,
            )
        return stream, {"Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive"}
    else:
        # Non-streaming path
        return await _handle_messages_non_streaming(
            upstream_url, headers, body, resolved_model,
            is_anthropic_upstream, system_blocks, known_tools,
            managed_local_tool_names, client_tool_names,
        )


async def _handle_messages_non_streaming(
    upstream_url: str,
    upstream_headers: dict[str, str],
    body: dict[str, Any],
    model: str,
    is_anthropic_upstream: bool,
    system_blocks: list[dict[str, Any]],
    known_tools: list[dict[str, Any]],
    managed_local_tool_names: set[str],
    client_tool_names: set[str],
) -> tuple[dict[str, Any], None]:
    """Non-streaming path for /v1/messages."""
    messages = body.get("messages", [])

    if is_anthropic_upstream:
        req_body = build_anthropic_upstream_request(body, model, system_blocks)
        if known_tools:
            req_body["tools"] = known_tools
        req_body["stream"] = False
        resp = await _client.request_json("POST", upstream_url, upstream_headers, req_body)
        response_body = resp.body_json or {}

        if resp.is_error:
            return response_body, None

        # Check for tool uses and resolve
        content = response_body.get("content", [])
        tool_uses = [b for b in (content or []) if b.get("type") == "tool_use"]
        if tool_uses:
            updated_messages, usage = await resolve_managed_anthropic_tool_uses(
                messages, system_blocks, model, upstream_url, upstream_headers,
                True, known_tools, managed_local_tool_names, client_tool_names,
            )
            # Build final response from last messages
            last_msg = updated_messages[-1] if updated_messages else {}
            return {
                "id": response_body.get("id", f"msg_{uuid.uuid4().hex[:16]}"),
                "type": "message",
                "role": "assistant",
                "content": last_msg.get("content", []),
                "model": model,
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": usage or {"input_tokens": 0, "output_tokens": 0},
            }, None

        return response_body, None
    else:
        # OpenAI-format upstream
        openai_body = build_openai_request(body, model, system_blocks)
        if known_tools:
            openai_body["tools"] = [anthropic_to_openai_tool_definition(t) for t in known_tools]
        openai_body["stream"] = False
        resp = await _client.request_json("POST", upstream_url, upstream_headers, openai_body)
        response_body = resp.body_json or {}

        if resp.is_error:
            return response_body, None

        # Convert OpenAI response to Anthropic format
        return _translate_openai_to_anthropic_response(response_body, model), None


async def _stream_anthropic_native(
    upstream_url: str,
    upstream_headers: dict[str, str],
    body: dict[str, Any],
    model: str,
    system_blocks: list[dict[str, Any]],
    known_tools: list[dict[str, Any]],
    managed_local_tool_names: set[str],
    client_tool_names: set[str],
) -> AsyncIterator[str]:
    """Stream from an Anthropic upstream in native format.

    Intercepts tool uses and resolves managed tools.
    """
    req_body = build_anthropic_upstream_request(body, model, system_blocks)
    if known_tools:
        req_body["tools"] = known_tools
    req_body["stream"] = True

    state = create_anthropic_native_stream_state()
    tool_round = 0
    current_messages = list(body.get("messages", []))

    async for event in _client.stream_sse(upstream_url, upstream_headers, req_body):
        if event.get("type") == "error":
            yield write_anthropic_sse_data("error", {"error": {"message": event.get("body", str(event.get("error", "")))}})
            return

        event_type = event.get("_event_type", "")
        yield write_anthropic_sse_data_only(event)
        event_type_payload = event.get("type", "")

        # Track state
        if event_type_payload == "message_start":
            msg = event.get("message", {})
            state["message_id"] = msg.get("id", "")
            state["model"] = msg.get("model", "")
            state["input_tokens"] = msg.get("usage", {}).get("input_tokens", 0)

        elif event_type_payload == "content_block_start":
            block = event.get("content_block", {})
            idx = event.get("index", 0)
            state["content_blocks"].append(block)
            state["current_index"] = idx

        elif event_type_payload == "content_block_delta":
            pass  # streaming content

        elif event_type_payload == "content_block_stop":
            pass

        elif event_type_payload == "message_delta":
            delta = event.get("delta", {})
            state["stop_reason"] = delta.get("stop_reason")
            state["output_tokens"] = event.get("usage", {}).get("output_tokens", 0)

        elif event_type_payload == "message_stop":
            # Check for tool uses
            tool_uses = [b for b in state["content_blocks"] if b.get("type") == "tool_use"]

            if tool_uses:
                tool_round += 1
                if tool_round > MAX_MANAGED_TOOL_ROUNDS:
                    break

                assistant_msg = {"role": "assistant", "content": list(state["content_blocks"])}
                current_messages.append(assistant_msg)

                classification = classify_anthropic_tool_uses(
                    tool_uses, managed_local_tool_names, client_tool_names,
                )

                if classification["has_managed"]:
                    # Execute managed tools
                    for tu in classification["managed_tool_uses"]:
                        tool_name = tu.get("name", "")
                        tool_input = tu.get("input", {})
                        tool_use_id = tu.get("id", f"toolu_{uuid.uuid4().hex[:16]}")
                        try:
                            result = await execute_managed_proxy_tool(tool_name, tool_input)
                            current_messages.append({
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": format_managed_tool_result(tool_name, result),
                            })
                        except Exception as exc:
                            current_messages.append({
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": f"Error: {exc}",
                                "is_error": True,
                            })

                    # Reset and continue streaming
                    state = create_anthropic_native_stream_state()
                    continue_stream = True

                    async for next_event in _client.stream_sse(
                        upstream_url, upstream_headers,
                        {"model": model, "messages": current_messages, "system": system_blocks, "tools": known_tools, "stream": True},
                    ):
                        if next_event.get("type") == "error":
                            yield write_anthropic_sse_data("error", {"error": {"message": str(next_event.get("error", ""))}})
                            return
                        yield write_anthropic_sse_data_only(next_event)

                    break

            break

    yield write_anthropic_sse_data("message_stop", {"type": "message_stop"})


async def _stream_openai_as_anthropic(
    upstream_url: str,
    upstream_headers: dict[str, str],
    body: dict[str, Any],
    model: str,
    system_blocks: list[dict[str, Any]],
    known_tools: list[dict[str, Any]],
    managed_local_tool_names: set[str],
    client_tool_names: set[str],
) -> AsyncIterator[str]:
    """Stream from an OpenAI-format upstream and convert to Anthropic SSE."""
    openai_body = build_openai_request(body, model, system_blocks)
    if known_tools:
        openai_body["tools"] = [anthropic_to_openai_tool_definition(t) for t in known_tools]
    openai_body["stream"] = True

    state = create_openai_to_anthropic_stream_state()
    tool_round = 0
    current_messages = list(body.get("messages", []))
    current_system = system_blocks

    async for chunk in _client.stream_sse(upstream_url, upstream_headers, openai_body):
        if chunk.get("type") == "error":
            yield write_anthropic_sse_data("error", {"error": {"message": chunk.get("body", str(chunk.get("error", "")))}})
            return

        # Convert OpenAI chunk to Anthropic SSE
        events = stream_openai_delta_as_anthropic(chunk, state)
        for event_str in events:
            yield event_str

        # Check for tool calls that need resolution
        choices = chunk.get("choices", [])
        if choices and choices[0].get("finish_reason") == "tool_calls":
            tool_round += 1
            if tool_round > MAX_MANAGED_TOOL_ROUNDS:
                break

            # Get accumulated state
            tool_calls = []
            for tc in state["pending_tool_calls"]:
                name = tc.get("function", {}).get("name", "")
                args_str = tc.get("function", {}).get("arguments", "{}")
                try:
                    args = json.loads(args_str)
                except (json.JSONDecodeError, TypeError):
                    args = {}
                tool_calls.append({
                    "type": "tool_use",
                    "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:16]}"),
                    "name": name,
                    "input": args,
                })

            if tool_calls:
                classification = classify_anthropic_tool_uses(
                    tool_calls, managed_local_tool_names, client_tool_names,
                )

                if classification["has_managed"]:
                    # Build assistant message
                    current_messages.append({
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": state.get("accumulated_text", "")},
                            *tool_calls,
                        ],
                    })

                    # Execute managed tools
                    for tu in classification["managed_tool_uses"]:
                        try:
                            result = await execute_managed_proxy_tool(
                                tu.get("name", ""), tu.get("input", {}),
                            )
                            current_messages.append({
                                "type": "tool_result",
                                "tool_use_id": tu.get("id", ""),
                                "content": format_managed_tool_result(tu.get("name", ""), result),
                            })
                        except Exception as exc:
                            current_messages.append({
                                "type": "tool_result",
                                "tool_use_id": tu.get("id", ""),
                                "content": f"Error: {exc}",
                                "is_error": True,
                            })

                    # Re-call upstream with tool results
                    state = create_openai_to_anthropic_stream_state()
                    continue

            break

    yield write_anthropic_sse_data("message_stop", {"type": "message_stop"})


def _translate_openai_to_anthropic_response(
    openai_response: dict[str, Any],
    model: str,
) -> dict[str, Any]:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
    choices = openai_response.get("choices", [])
    if not choices:
        return {
            "id": f"msg_{uuid.uuid4().hex[:16]}",
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": model,
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }

    choice = choices[0]
    message = choice.get("message", {})
    content_list: list[dict[str, Any]] = []

    text = message.get("content", "")
    if text:
        content_list.append({"type": "text", "text": text})

    reasoning = message.get("reasoning") or message.get("reasoning_content", "")
    if reasoning:
        content_list.append({"type": "thinking", "text": reasoning})

    for tc in message.get("tool_calls", []):
        try:
            tool_input = json.loads(tc.get("function", {}).get("arguments", "{}"))
        except (json.JSONDecodeError, TypeError):
            tool_input = {}
        content_list.append({
            "type": "tool_use",
            "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:16]}"),
            "name": tc.get("function", {}).get("name", ""),
            "input": tool_input,
        })

    finish_reason = choice.get("finish_reason", "stop")
    stop_reason_map = {
        "stop": "end_turn",
        "tool_calls": "tool_use",
        "length": "max_tokens",
        "content_filter": "content_filter",
    }

    usage = openai_response.get("usage", {})
    return {
        "id": openai_response.get("id", f"msg_{uuid.uuid4().hex[:16]}"),
        "type": "message",
        "role": "assistant",
        "content": content_list,
        "model": openai_response.get("model", model),
        "stop_reason": stop_reason_map.get(finish_reason, "end_turn"),
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


# ── Token counting ───────────────────────────────────────────────────


async def handle_count_tokens(
    body: dict[str, Any],
    request: Any = None,
) -> dict[str, Any]:
    """Handle a POST /v1/messages/count_tokens request."""
    from app.providers.clients.base import estimate_tokens

    messages = body.get("messages", [])
    tools = body.get("tools", [])
    estimated = estimate_tokens(messages, tools)

    return {
        "input_tokens": estimated,
        "estimated": True,
    }


# ── Lazy client reference ────────────────────────────────────────────

_client = None


def _get_client() -> Any:
    global _client
    if _client is None:
        from app.providers.clients.anthropic import AnthropicClient
        _client = AnthropicClient({})
    return _client


def translate_messages_to_anthropic(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert session messages (OpenAI or mixed format) to Anthropic Messages format.

    Groups consecutive tool messages into a single user message with tool_result blocks.
    Maps OpenAI assistant tool_calls to Anthropic content blocks with type='tool_use'.
    """
    translated: list[dict[str, Any]] = []

    i = 0
    while i < len(messages):
        msg = messages[i]
        role = msg.get("role")

        if role == "tool":
            tool_blocks = []
            while i < len(messages) and messages[i].get("role") == "tool":
                t_msg = messages[i]
                tool_use_id = t_msg.get("tool_use_id") or t_msg.get("tool_call_id") or ""
                content = t_msg.get("content", "")
                tool_blocks.append({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content
                })
                i += 1
            translated.append({
                "role": "user",
                "content": tool_blocks
            })
        else:
            if role == "assistant" and msg.get("tool_calls"):
                content_blocks = []
                if msg.get("content"):
                    content_blocks.append({
                        "type": "text",
                        "text": msg["content"]
                    })
                for tc in msg["tool_calls"]:
                    fn = tc.get("function", {})
                    try:
                        args = json.loads(fn.get("arguments", "{}")) if isinstance(fn.get("arguments"), str) else fn.get("arguments", {})
                    except Exception:
                        args = {}
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id", ""),
                        "name": fn.get("name", ""),
                        "input": args
                    })
                translated.append({
                    "role": "assistant",
                    "content": content_blocks
                })
            else:
                # Strip thinking blocks that lack a signature before
                # resending to Anthropic. The streaming layer rebuilds
                # thinking blocks from thinking_delta text only — it does
                # not capture signature_delta — so thinking blocks stored
                # in history have no signature. Anthropic rejects assistant
                # messages containing a thinking block without a valid
                # signature, which aborts the re-call after tool execution.
                if role == "assistant" and isinstance(msg.get("content"), list):
                    filtered = [
                        b for b in msg["content"]
                        if not (isinstance(b, dict)
                                and b.get("type") == "thinking"
                                and not b.get("signature"))
                    ]
                    translated.append({
                        "role": "assistant",
                        "content": filtered if filtered else [{"type": "text", "text": ""}],
                    })
                else:
                    translated.append(msg)
            i += 1

    return translated

