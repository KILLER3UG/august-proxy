"""Anthropic Messages API Pydantic models.

Strict models for fields the proxy reads/constructs (tool use/result blocks).
Loose (extra="allow") models for request/response shapes where only routing
fields are typed and message content passes through unchanged.
"""

from __future__ import annotations

from typing import TypedDict
from app.models.base import ExtraAllowBaseModel, JsonValue


# ── Strict models (the proxy reads/constructs these) ──────────────────────


class ToolUseBlock(ExtraAllowBaseModel):
    """Strict — the proxy constructs these and reads them in the tool loop."""

    type: str = 'tool_use'
    id: str
    name: str
    input: dict[str, object]


class ToolResultBlock(ExtraAllowBaseModel):
    """Strict — the proxy constructs these in the tool resolution loop."""

    type: str = 'tool_result'
    tool_use_id: str
    content: str | list[JsonValue]
    is_error: bool = False


# ── Loose models (extra="allow", typed only for fields the proxy reads) ──


class ContentBlock(ExtraAllowBaseModel):
    """Loose — content blocks come in many shapes (text, image, tool_use, thinking).

    Only ``type`` is typed; the rest passes through via ``extra="allow"``.
    """

    type: str


class AnthropicMessage(ExtraAllowBaseModel):
    """Loose — the proxy reads ``role`` but forwards content untouched."""

    role: str


# August routing / bookkeeping — never forward to Anthropic-compatible gateways.
_AUGUST_ONLY_ANTHROPIC_KEYS = frozenset({'session_id', 'sessionId'})


def dump_anthropic_upstream_body(
    body: AnthropicRequest | dict[str, object],
) -> dict[str, object]:
    """Serialize an Anthropic messages body for upstream without null / August-only keys."""
    if isinstance(body, AnthropicRequest):
        dumped: dict[str, object] = body.model_dump(exclude_none=True)  # type: ignore[assignment]
    else:
        dumped = {k: v for k, v in body.items() if v is not None}
    for key in _AUGUST_ONLY_ANTHROPIC_KEYS:
        dumped.pop(key, None)
    return dumped


class AnthropicRequest(ExtraAllowBaseModel):
    """Loose on messages, strict on routing fields.

    Fields the proxy acts on are typed explicitly. Everything else
    (messages, system, metadata, thinking) passes through via extra="allow".

    Commonly-accessed extra fields are annotated as ``JsonValue | None``
    so the type-checker doesn't reject access. At runtime they may be
    ``None`` if the client didn't send them (Pydantic's extra="allow"
    returns the raw JSON value or ``None``).
    """

    model: str
    max_tokens: int | None = None
    stream: bool = False
    stop_sequences: list[str] | None = None
    tools: list[dict[str, object]] | None = None
    tool_choice: dict[str, object] | None = None
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    # Extra fields the proxy reads (typed as optional JsonValue so mypy
    # doesn't reject access — narrowing is done via as_* helpers):
    messages: JsonValue | None = None
    system: JsonValue | None = None
    metadata: JsonValue | None = None
    thinking: JsonValue | None = None
    session_id: JsonValue | None = None


class AnthropicUsage(ExtraAllowBaseModel):
    """Usage information in an Anthropic response."""

    input_tokens: int = 0
    output_tokens: int = 0


class AnthropicResponse(ExtraAllowBaseModel):
    """Typed representation of an Anthropic Messages API response.

    Loose — most fields pass through. Only the ones the proxy reads
    (content, role, model, usage, stop_reason) are typed.
    """

    id: str = ''
    type: str = 'message'
    role: str = 'assistant'
    content: list[dict[str, object]] = []
    model: str = ''
    stop_reason: str | None = None
    stop_sequence: str | None = None
    usage: AnthropicUsage = AnthropicUsage()


class AnthropicSSEEvent(TypedDict, total=False):
    """A single SSE event from the Anthropic Messages API stream.

    Has ``type`` (message_start, content_block_start, content_block_delta,
    content_block_stop, message_delta, message_stop) and event-specific
    payload keys.
    """

    type: str
    _event_type: str
    message: dict[str, object]
    index: int
    content_block: dict[str, object]
    delta: dict[str, object]
    usage: dict[str, object]
