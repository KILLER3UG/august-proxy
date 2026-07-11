"""OpenAI Chat Completions Pydantic models.

Strict models for tool/function shapes the proxy constructs.
Loose (extra="allow") models for request/response shapes.
"""
from __future__ import annotations

from app.models.base import ExtraAllowBaseModel, JsonValue


# ── Strict models (the proxy reads/constructs these) ──────────────────────

class FunctionDefinition(ExtraAllowBaseModel):
    """Strict — the proxy constructs these for managed tool definitions."""
    name: str
    description: str = ""
    parameters: dict[str, JsonValue] = {"type": "object", "properties": {}}
    strict: bool | None = None


class ToolDefinition(ExtraAllowBaseModel):
    """Strict — used for managed tool injection."""
    type: str = "function"
    function: FunctionDefinition


class ToolCall(ExtraAllowBaseModel):
    """Strict — the proxy reads these in the tool resolution loop."""
    id: str
    type: str = "function"
    function: FunctionDefinition


class FunctionCall(ExtraAllowBaseModel):
    """Strict — the proxy constructs these for response building."""
    name: str
    arguments: str = "{}"


# ── Loose models (extra="allow", typed only for fields the proxy reads) ──

class ChatMessage(ExtraAllowBaseModel):
    """Loose — the proxy reads role but forwards content untouched."""
    role: str
    # content, tool_calls, function_call → pass through via extra="allow"


class ChatCompletionRequest(ExtraAllowBaseModel):
    """Loose on messages, strict on routing fields."""
    model: str
    max_tokens: int | None = None
    stream: bool = False
    stop: str | list[str] | None = None
    temperature: float | None = None
    top_p: float | None = None
    # Extra fields the proxy reads:
    messages: JsonValue | None = None
    user: JsonValue | None = None
    metadata: JsonValue | None = None
    session_id: JsonValue | None = None


class Usage(ExtraAllowBaseModel):
    """Loose usage tracking model."""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class StreamChoice(ExtraAllowBaseModel):
    """A single streaming choice."""
    index: int = 0
    finish_reason: str | None = None


class StreamChunk(ExtraAllowBaseModel):
    """Loose streaming chunk model."""
    id: str = ""
    object: str = "chat.completion.chunk"
    created: int = 0
    model: str = ""
    choices: list[StreamChoice] = []
