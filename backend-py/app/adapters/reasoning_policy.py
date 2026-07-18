"""Shared helpers for preserving model reasoning across tool-loop re-sends."""

from __future__ import annotations

from app.json_narrowing import as_str


def attach_openai_reasoning(assistant_msg: dict[str, object], text: object) -> dict[str, object]:
    """Attach reasoning fields onto an OpenAI-shaped assistant message.

    Always sets both ``reasoning_content`` (DeepSeek / many OpenAI-compat
    reasoners) and ``reasoning`` when *text* is non-empty. Providers that
    ignore unknown fields are unaffected.
    """
    reasoning = as_str(text, '').strip()
    if reasoning:
        assistant_msg['reasoning_content'] = reasoning
        assistant_msg['reasoning'] = reasoning
    return assistant_msg
