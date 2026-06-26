"""
Context compressor — summarizes middle messages to fit within token thresholds
while preserving head and tail messages.

Port of backend/services/memory/context-compressor.js (177 lines).
"""

from __future__ import annotations

import os
from typing import Any, Callable

from app.providers.clients.base import estimate_tokens

DEFAULT_HEAD_COUNT = 4
DEFAULT_TAIL_COUNT = 6
DEFAULT_SUMMARY_MARKER = "<<compressed_summary"
DEFAULT_MAX_SUMMARY_CHARS = 2000
FEATURE_FLAG = "AUGUST_SUMMARIZING_COMPACTOR"


def is_feature_enabled() -> bool:
    """Check if the summarizing compactor feature flag is set."""
    return os.environ.get(FEATURE_FLAG) == "1"


def local_summarize(
    messages: list[dict[str, Any]],
    max_summary_chars: int = DEFAULT_MAX_SUMMARY_CHARS,
) -> str:
    """Default local summarizer.

    Joins text content from each message, truncates to max_summary_chars,
    and returns the summary string.
    """
    lines: list[str] = []
    for msg in messages:
        role = msg.get("role", "unknown")
        content = msg.get("content", "")

        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = " ".join(
                str(b.get("text", ""))
                for b in content
                if isinstance(b, dict) and b.get("type") in ("text", "output_text")
            )
        elif content:
            try:
                import json
                text = json.dumps(content)
            except (TypeError, ValueError):
                text = str(content)

        # Append tool call names
        tool_calls = msg.get("tool_calls", [])
        if tool_calls:
            names = [tc.get("function", {}).get("name", tc.get("name", "")) for tc in tool_calls]
            names = [n for n in names if n]
            if names:
                text += f" [tool_calls: {', '.join(names)}]"

        trimmed = " ".join(text.split())[:600]
        if trimmed:
            lines.append(f"[{role}] {trimmed}")

    summary = "\n".join(lines)
    if len(summary) > max_summary_chars:
        summary = summary[:max_summary_chars] + "…"
    return summary


def build_summary_message(
    middle_messages: list[dict[str, Any]],
    summary_text: str,
    summary_marker: str = DEFAULT_SUMMARY_MARKER,
) -> dict[str, Any]:
    """Build a fenced summary message from the middle messages."""
    import json
    meta = json.dumps({
        "marker": "august.summary",
        "compressed_count": len(middle_messages),
    })
    return {
        "role": "system",
        "content": f"{summary_marker}\n{meta}\n{summary_text}\n{summary_marker.replace('<', '</')}>>",
    }


def compress_messages(
    messages: list[dict[str, Any]],
    threshold: int,
    head_count: int = DEFAULT_HEAD_COUNT,
    tail_count: int = DEFAULT_TAIL_COUNT,
    summarizer: Callable | None = None,
) -> list[dict[str, Any]]:
    """Compress messages to fit within a token threshold by summarizing the middle.

    Preserves the first ``head_count`` and last ``tail_count`` messages,
    summarizing everything in between.

    Args:
        messages: Full conversation messages.
        threshold: Token threshold to compress under.
        head_count: Number of messages to preserve at the start.
        tail_count: Number of messages to preserve at the end.
        summarizer: Optional async callable that returns a summary string.

    Returns:
        Compressed message list (may be unchanged if already under threshold).
    """
    if not messages:
        return messages

    # Quick check — if already under threshold, return unchanged
    current_tokens = estimate_tokens(messages)
    if current_tokens <= threshold:
        return list(messages)

    non_system = [m for m in messages if m.get("role") != "system"]
    system_msgs = [m for m in messages if m.get("role") == "system"]

    if len(non_system) <= head_count + tail_count:
        # Not enough messages to compress meaningfully
        return list(messages)

    head = non_system[:head_count]
    tail = non_system[-tail_count:]
    middle = non_system[head_count:-tail_count] if tail_count > 0 else non_system[head_count:]

    if not middle:
        return list(messages)

    # Summarize
    if summarizer:
        summary_text = summarizer(middle)
    else:
        summary_text = local_summarize(middle)

    summary_msg = build_summary_message(middle, summary_text)

    compressed = system_msgs + head + [summary_msg] + tail

    # Double-check we actually saved tokens
    compressed_tokens = estimate_tokens(compressed)
    if compressed_tokens >= current_tokens:
        # Compression didn't help; return original
        return list(messages)

    return compressed
