"""
Context compressor — summarizes middle messages to fit within token thresholds
while preserving head and tail messages.

Port of backend/services/memory/context-compressor.js (177 lines).
"""

from __future__ import annotations

import inspect
import os
from typing import Callable

from app.json_narrowing import as_int, as_list, as_str
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
            # Denser elision (surpass #4): assistant blocks keep only the
            # FINAL text block — earlier provisional text and thinking are
            # noise once the answer exists.
            blocks = [b for b in content if isinstance(b, dict)]
            text_blocks = [
                str(b.get('text', ''))
                for b in blocks
                if b.get('type') in ('text', 'output_text')
            ]
            if role == 'assistant' and text_blocks:
                text = text_blocks[-1]
            else:
                text = ' '.join(text_blocks)
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
        # Denser elision: tool results (the largest blocks) slim to one line;
        # users keep 400 chars, assistant text 600.
        cap = 120 if role == 'tool' else (400 if role == 'user' else 600)
        trimmed = ' '.join(text.split())[:cap]
        if trimmed:
            lines.append(f'[{role}] {trimmed}')
    summary = '\n'.join(lines)
    if len(summary) > maxSummaryChars:
        summary = summary[:maxSummaryChars] + '…'
    return summary


def buildSummaryMessage(
    middleMessages: list[dict[str, object]],
    summaryText: str,
    summaryMarker: str = DEFAULT_SUMMARY_MARKER,
    role: str = 'user',
) -> dict[str, object]:
    """Build a fenced summary message from the middle messages.

    Role defaults to ``user`` — a mid-transcript ``system`` message breaks the
    Anthropic wire format (the Messages API has no system role inside
    ``messages``) and would 400 the next turn after compaction.
    """
    import json

    meta = json.dumps({'marker': 'august.summary', 'compressed_count': len(middleMessages)})
    return {
        'role': role,
        'content': f'{summaryMarker}\n{meta}\n{summaryText}\n{summaryMarker.replace("<", "</")}>>',
    }


def _isSummaryMessage(msg: dict[str, object], summaryMarker: str = DEFAULT_SUMMARY_MARKER) -> bool:
    """True if msg is a prior compressed-summary block (any role).

    Detected by the full fenced shape — opening marker ``<<compressed_summary``
    plus the closing fence — in string content. Role-agnostic so legacy
    system-role summaries (older builds) and current user-role summaries are
    both recognized, while a user message that merely starts with the marker
    text is not mistaken for one.
    """
    content = msg.get('content', '')
    if not isinstance(content, str):
        return False
    closing = f'{summaryMarker.replace("<", "</")}>>'
    return content.startswith(summaryMarker) and closing in content


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


async def compressMessages(
    messages: list[dict[str, object]],
    threshold: int,
    head_count: int = DEFAULT_HEAD_COUNT,
    tail_count: int = DEFAULT_TAIL_COUNT,
    summarizer: Callable | None = None,
    pin_predicates: list[Callable[[dict[str, object]], bool]] | None = None,
    max_pinned: int = 4,
) -> list[dict[str, object]]:
    """Compress messages to fit within a token threshold by summarizing the middle.

    Preserves the first ``head_count`` and last ``tail_count`` messages,
    summarizing everything in between.

    Args:
        messages: Full conversation messages.
        threshold: Token threshold to compress under.
        head_count: Number of messages to preserve at the start.
        tail_count: Number of messages to preserve at the end.
        summarizer: Optional callable — sync or async — that returns a summary
            string; awaited transparently. ``localSummarize`` is the default.
        pin_predicates: Optional predicates marking MIDDLE messages as
            landmarks to keep verbatim (e.g. the latest update_state
            transition, a failing verification receipt). A middle-summary
            drops the only mention of a file path or error string — pinned
            messages survive it, so key state is not lost. At most
            ``max_pinned`` landmarks are retained (guards against
            re-bloating the compressed window).

    Returns:
        Compressed message list (may be unchanged if already under threshold).
    """
    if not messages:
        return messages
    currentTokens = estimateTokens(messages)
    if currentTokens <= threshold:
        return list(messages)
    nonSystem = [m for m in messages if m.get('role') != 'system' and not _isSummaryMessage(m)]
    systemMsgs = [m for m in messages if m.get('role') == 'system' and not _isSummaryMessage(m)]
    priorSummaryTexts = [_extractSummaryText(m) for m in messages if _isSummaryMessage(m)]
    priorSummaryTexts = [t for t in priorSummaryTexts if t]
    otherSystem = systemMsgs
    if len(nonSystem) <= head_count + tail_count:
        return list(messages)
    head = nonSystem[:head_count]
    tail = nonSystem[-tail_count:]
    middle = nonSystem[head_count:-tail_count] if tail_count > 0 else nonSystem[head_count:]
    if not middle:
        return list(messages)
    # Landmark pins: middle messages a predicate marks are kept VERBATIM
    # (before the summary) instead of being folded into it.
    pinned: list[dict[str, object]] = []
    if pin_predicates:
        for m in middle:
            if len(pinned) >= max_pinned:
                break
            if any(p(m) for p in pin_predicates):
                pinned.append(m)
        if pinned:
            pinnedIds = {id(m) for m in pinned}
            middle = [m for m in middle if id(m) not in pinnedIds]
    if not middle:
        # The whole middle was pinned — no summary needed.
        compressed = otherSystem + head + pinned + tail
        compressedTokens = estimateTokens(compressed)
        if compressedTokens >= currentTokens:
            return list(messages)
        return compressed
    if summarizer:
        summaryText = summarizer(middle)
        if inspect.isawaitable(summaryText):
            summaryText = await summaryText
    else:
        summaryText = localSummarize(middle)
    if priorSummaryTexts:
        summaryText = 'Earlier summary:\n' + '\n---\n'.join(priorSummaryTexts) + '\n\nRecent summary:\n' + summaryText
    summaryMsg = buildSummaryMessage(middle, summaryText)
    # Aggregate the compacted region's usage into the summary message so the
    # conversation's usage details survive compaction AND restart: the SSE
    # events are volatile, but the persisted summary carries the totals
    # (audit fix).
    try:
        aggIn = 0
        aggOut = 0
        for m in middle:
            u = m.get('usage')
            if isinstance(u, dict):
                aggIn += as_int(u.get('inputTokens') or u.get('input_tokens'), 0)
                aggOut += as_int(u.get('outputTokens') or u.get('output_tokens'), 0)
        if aggIn > 0 or aggOut > 0:
            summaryMsg['usage'] = {
                'inputTokens': aggIn,
                'outputTokens': aggOut,
                'compacted': True,
            }
    except Exception:
        pass
    compressed = otherSystem + head + pinned + [summaryMsg] + tail
    compressedTokens = estimateTokens(compressed)
    if compressedTokens >= currentTokens:
        return list(messages)
    return compressed
