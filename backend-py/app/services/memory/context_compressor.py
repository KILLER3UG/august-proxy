"""
Context compressor — summarizes middle messages to fit within token thresholds
while preserving head and tail messages.

Port of backend/services/memory/context-compressor.js (177 lines).
"""

from __future__ import annotations
import os
from typing import Callable
from app.jsonUtils import as_list, as_str
from app.providers.clients.base import estimateTokens

DEFAULT_HEAD_COUNT = 4
DEFAULT_TAIL_COUNT = 6
DEFAULT_SUMMARY_MARKER = '<<compressed_summary'
DEFAULT_MAX_SUMMARY_CHARS = 2000
FEATURE_FLAG = 'AUGUST_SUMMARIZING_COMPACTOR'


def isFeatureEnabled() -> bool:
    """Check if the summarizing compactor feature flag is set.

    Enabled by default — the env var AUGUST_SUMMARIZING_COMPACTOR
    can be set to "0" to disable."""
    val = os.environ.get(FEATURE_FLAG)
    if val is not None:
        return val == '1'
    return True


def localSummarize(messages: list[dict[str, object]], maxSummaryChars: int = DEFAULT_MAX_SUMMARY_CHARS) -> str:
    """Default local summarizer.

    Joins text content from each message, truncates to max_summary_chars,
    and returns the summary string.
    """
    lines: list[str] = []
    for msg in messages:
        role = msg.get('role', 'unknown')
        content = msg.get('content', '')
        text = ''
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = ' '.join(
                (
                    str(b.get('text', ''))
                    for b in content
                    if isinstance(b, dict) and b.get('type') in ('text', 'output_text')
                )
            )
        elif content:
            try:
                import json

                text = json.dumps(content)
            except (TypeError, ValueError):
                text = str(content)
        toolCalls = as_list(msg.get('tool_calls'))
        if toolCalls:
            names: list[str] = []
            for tc in toolCalls:
                if not isinstance(tc, dict):
                    continue
                func = tc.get('function')
                name = as_str(func.get('name')) if isinstance(func, dict) else ''
                if not name:
                    name = as_str(tc.get('name'))
                if name:
                    names.append(name)
            if names:
                text += f' [tool_calls: {", ".join(names)}]'
        trimmed = ' '.join(text.split())[:600]
        if trimmed:
            lines.append(f'[{role}] {trimmed}')
    summary = '\n'.join(lines)
    if len(summary) > maxSummaryChars:
        summary = summary[:maxSummaryChars] + '…'
    return summary


def buildSummaryMessage(
    middleMessages: list[dict[str, object]], summaryText: str, summaryMarker: str = DEFAULT_SUMMARY_MARKER
) -> dict[str, object]:
    """Build a fenced summary message from the middle messages."""
    import json

    meta = json.dumps({'marker': 'august.summary', 'compressed_count': len(middleMessages)})
    return {
        'role': 'system',
        'content': f'{summaryMarker}\n{meta}\n{summaryText}\n{summaryMarker.replace("<", "</")}>>',
    }


def _isSummaryMessage(msg: dict[str, object], summaryMarker: str = DEFAULT_SUMMARY_MARKER) -> bool:
    """True if msg is a prior compressed-summary system block.

    Detected by the opening marker (`<<compressed_summary`) in a system
    message's string content. The compactor emits exactly this shape from
    build_summary_message, so this reliably identifies prior summaries that
    would otherwise accumulate across repeated compactions (s4).
    """
    if msg.get('role') != 'system':
        return False
    content = msg.get('content', '')
    if not isinstance(content, str):
        return False
    return content.startswith(summaryMarker)


def _extractSummaryText(msg: dict[str, object], summaryMarker: str = DEFAULT_SUMMARY_MARKER) -> str:
    """Recover the human summary text from a fenced summary message.

        build_summary_message emits
        ``{marker}
    {meta_json}
    {summary_text}
    {closing}``. Drop the first line
        (marker), the second (meta json), and the last (closing marker) to get the
        body. Returns "" if the shape is unexpected.
    """
    content = msg.get('content', '')
    if not isinstance(content, str) or not content.startswith(summaryMarker):
        return ''
    lines = content.split('\n')
    if len(lines) < 3:
        return ''
    return '\n'.join(lines[2:-1])


def compressMessages(
    messages: list[dict[str, object]],
    threshold: int,
    head_count: int = DEFAULT_HEAD_COUNT,
    tail_count: int = DEFAULT_TAIL_COUNT,
    summarizer: Callable | None = None,
) -> list[dict[str, object]]:
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
    currentTokens = estimateTokens(messages)
    if currentTokens <= threshold:
        return list(messages)
    nonSystem = [m for m in messages if m.get('role') != 'system']
    systemMsgs = [m for m in messages if m.get('role') == 'system']
    priorSummaryTexts = [_extractSummaryText(m) for m in systemMsgs if _isSummaryMessage(m)]
    priorSummaryTexts = [t for t in priorSummaryTexts if t]
    otherSystem = [m for m in systemMsgs if not _isSummaryMessage(m)]
    if len(nonSystem) <= head_count + tail_count:
        return list(messages)
    head = nonSystem[:head_count]
    tail = nonSystem[-tail_count:]
    middle = nonSystem[head_count:-tail_count] if tail_count > 0 else nonSystem[head_count:]
    if not middle:
        return list(messages)
    if summarizer:
        summaryText = summarizer(middle)
    else:
        summaryText = localSummarize(middle)
    if priorSummaryTexts:
        summaryText = 'Earlier summary:\n' + '\n---\n'.join(priorSummaryTexts) + '\n\nRecent summary:\n' + summaryText
    summaryMsg = buildSummaryMessage(middle, summaryText)
    compressed = otherSystem + head + [summaryMsg] + tail
    compressedTokens = estimateTokens(compressed)
    if compressedTokens >= currentTokens:
        return list(messages)
    return compressed
