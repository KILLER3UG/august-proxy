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

# ── Prune-then-compact (plan §9.3 #2) ──
# Tier (a) projection prune: protect the newest PROTECTED_TOOL_TOKENS of tool
# outputs; older tool results are rewritten in the model-facing projection
# only (history itself untouched). Stage A shape (companion to #3): old
# results over PRUNE_THRESHOLD_CHARS keep head+tail with a middle-elision
# marker; smaller old results are cleared outright.
PROTECTED_TOOL_TOKENS = 40_000
PRUNE_THRESHOLD_CHARS = 8192
PRUNE_HEAD_CHARS = 4096
PRUNE_TAIL_CHARS = 1024
CLEARED_MARKER = '[Old tool result content cleared]'
PRUNE_ELISION_MARKER = '[... middle omitted'
# Tier (b) compaction ratios (documented calibration defaults): trigger at
# 0.8 × context window, retain the newest 0.16 verbatim, cap the summary at
# 8192 tokens.
COMPACT_TRIGGER_RATIO = 0.80
COMPACT_RETAIN_RATIO = 0.16
SUMMARY_CAP_TOKENS = 8192
# Compaction lock TTL: a mid-compaction crash must not block compaction
# forever — an orphaned lock older than the TTL is treated as released.
LOCK_TTL_S = 300.0


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


# ── Tier (a): projection prune of old tool outputs (§9.3 #2 + #3 stage A) ──


def _approxTokens(text: str) -> int:
    """Cheap char→token estimate (4 chars/token) for prune budgeting."""
    return max(1, len(text) // 4)


def _toolResultSlots(msg: dict[str, object]) -> list[tuple[str, int] | None]:
    """Enumerate the tool-result text slots of one message.

    Returns a list with one entry per slot: ``('content', -1)`` for a
    plain ``role: tool`` message, or ``('block', i)`` for each
    ``tool_result`` block inside a user message's content list. Non-result
    messages return an empty list.
    """
    role = msg.get('role')
    content = msg.get('content')
    if role == 'tool' and isinstance(content, str):
        return [('content', -1)]
    if role in ('user', 'tool') and isinstance(content, list):
        slots: list[tuple[str, int] | None] = []
        for i, b in enumerate(content):
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                slots.append(('block', i))
        return slots
    return []


def _slotText(msg: dict[str, object], slot: tuple[str, int] | None) -> str:
    if slot is None:
        return ''
    kind, idx = slot
    if kind == 'content':
        return as_str(msg.get('content'))
    content = msg.get('content')
    if isinstance(content, list) and 0 <= idx < len(content):
        block = content[idx]
        if isinstance(block, dict):
            c = block.get('content')
            if isinstance(c, str):
                return c
            if isinstance(c, list):
                return '\n'.join(
                    as_str(b.get('text')) for b in c if isinstance(b, dict) and b.get('type') == 'text'
                )
    return ''


def _rewriteSlot(msg: dict[str, object], slot: tuple[str, int] | None, text: str) -> dict[str, object]:
    """Return a copy of ``msg`` with one tool-result slot replaced."""
    if slot is None:
        return msg
    kind, idx = slot
    copy = dict(msg)
    if kind == 'content':
        copy['content'] = text
        return copy
    content = msg.get('content')
    if isinstance(content, list) and 0 <= idx < len(content):
        newContent = list(content)
        block = newContent[idx]
        if isinstance(block, dict):
            newBlock = dict(block)
            c = newBlock.get('content')
            if isinstance(c, list):
                newBlock['content'] = [{'type': 'text', 'text': text}]
            else:
                newBlock['content'] = text
            newContent[idx] = newBlock
        copy['content'] = newContent
    return copy


def _pruneOne(text: str) -> str:
    """Stage A rewrite of a single old tool result (deterministic)."""
    if len(text) <= PRUNE_THRESHOLD_CHARS:
        return CLEARED_MARKER
    omitted = len(text) - PRUNE_HEAD_CHARS - PRUNE_TAIL_CHARS
    return (
        text[:PRUNE_HEAD_CHARS]
        + f'\n{PRUNE_ELISION_MARKER} — {omitted} characters cleared]\n'
        + text[-PRUNE_TAIL_CHARS:]
    )


def pruneToolOutputs(
    messages: list[dict[str, object]], protectTokens: int = PROTECTED_TOOL_TOKENS
) -> list[dict[str, object]]:
    """Projection prune: blank old tool outputs in a COPY of the transcript.

    Walks from the end, protecting the newest ``protectTokens`` of tool
    output; every older tool result is rewritten — large ones keep
    head 4096 + tail 1024 code points with a middle-elision marker (stage A),
    small ones are cleared to ``CLEARED_MARKER``. The input list and its
    messages are never mutated (non-destructive projection).
    """
    slots: list[tuple[int, tuple[str, int] | None, str]] = []
    for i, m in enumerate(messages):
        for slot in _toolResultSlots(m):
            if slot is not None:
                slots.append((i, slot, _slotText(m, slot)))
    if not slots:
        return list(messages)
    protected: set[tuple[int, int]] = set()
    acc = 0
    newest = True
    for i, slot, text in reversed(slots):
        tokens = _approxTokens(text)
        # The newest tool result is always protected — blanking the freshest
        # output would defeat the point even when it alone exceeds the budget.
        if newest or acc + tokens <= protectTokens:
            protected.add((i, slot[1] if slot else -1))
            acc += tokens
            newest = False
    out = list(messages)
    for i, slot, text in slots:
        key = (i, slot[1] if slot else -1)
        if key in protected:
            continue
        if not text or text == CLEARED_MARKER or PRUNE_ELISION_MARKER in text[: PRUNE_HEAD_CHARS + 80]:
            continue  # already pruned — idempotent
        out[i] = _rewriteSlot(out[i], slot, _pruneOne(text))
    return out


# ── Tool-pair-safe unit splitting (a tool result stays with its call) ──


def _hasToolUse(msg: dict[str, object]) -> bool:
    if msg.get('role') != 'assistant':
        return False
    content = msg.get('content')
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get('type') == 'tool_use':
                return True
    for tc in as_list(msg.get('tool_calls')):
        if isinstance(tc, dict):
            return True
    return False


def _isToolResultMsg(msg: dict[str, object]) -> bool:
    return bool(_toolResultSlots(msg))


def _splitUnits(messages: list[dict[str, object]]) -> list[list[dict[str, object]]]:
    """Group messages into atomic units: an assistant tool-call message plus
    ALL tool results that follow it stay one unit, so no compaction boundary
    can orphan a tool result from its call (wire-format safety)."""
    units: list[list[dict[str, object]]] = []
    i = 0
    n = len(messages)
    while i < n:
        m = messages[i]
        if _hasToolUse(m):
            unit = [m]
            j = i + 1
            while j < n and _isToolResultMsg(messages[j]):
                unit.append(messages[j])
                j += 1
            units.append(unit)
            i = j
        else:
            units.append([m])
            i += 1
    return units


# ── Fixed markdown summary schema (§9.3 #2) ──

_READ_TOOLS = {'read_file', 'list_files', 'search_files', 'grep_files', 'glob', 'grep'}
_MODIFY_TOOLS = {
    'write_file',
    'edit_file',
    'edit_lines',
    'create_file',
    'str_replace',
    'str_replace_editor',
    'apply_patch',
    'patch_file',
}


def _iterToolCalls(messages: list[dict[str, object]]):
    """Yield (name, inputDict) for every tool call in assistant messages."""
    for m in messages:
        if m.get('role') != 'assistant':
            continue
        content = m.get('content')
        if isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get('type') == 'tool_use':
                    inp = b.get('input')
                    yield as_str(b.get('name')), (inp if isinstance(inp, dict) else {})
        for tc in as_list(m.get('tool_calls')):
            if not isinstance(tc, dict):
                continue
            fn = tc.get('function')
            name = ''
            callInput: dict[str, object] = {}
            if isinstance(fn, dict):
                name = as_str(fn.get('name'))
                raw = fn.get('arguments')
                if isinstance(raw, dict):
                    callInput = raw
                elif isinstance(raw, str):
                    try:
                        import json

                        parsed = json.loads(raw)
                        callInput = parsed if isinstance(parsed, dict) else {}
                    except (ValueError, TypeError):
                        callInput = {}
            if name:
                yield name, callInput


def extractFileLedger(messages: list[dict[str, object]]) -> tuple[list[str], list[str]]:
    """Deterministic read/modified file ledger from tool-call arguments."""
    read: list[str] = []
    modified: list[str] = []
    for name, inp in _iterToolCalls(messages):
        path = as_str(inp.get('path') or inp.get('file_path') or inp.get('filePath') or '')
        if not path:
            continue
        if name in _MODIFY_TOOLS:
            if path not in modified:
                modified.append(path)
        elif name in _READ_TOOLS:
            if path not in read and path not in modified:
                read.append(path)
    return read, modified


def _parseLedgerTags(text: str) -> tuple[list[str], list[str]]:
    """Recover <read-files>/<modified-files> ledgers from a prior summary."""
    import re

    def _grab(tag: str) -> list[str]:
        m = re.search(rf'<{tag}>\n?(.*?)\n?</{tag}>', text, re.DOTALL)
        if not m:
            return []
        return [ln.strip() for ln in m.group(1).splitlines() if ln.strip()]

    return _grab('read-files'), _grab('modified-files')


def _firstUserText(messages: list[dict[str, object]]) -> str:
    for m in messages:
        if m.get('role') != 'user':
            continue
        content = m.get('content')
        if isinstance(content, str) and content.strip() and not content.startswith('<<compressed_summary'):
            return ' '.join(content.split())
        if isinstance(content, list):
            texts = [
                as_str(b.get('text'))
                for b in content
                if isinstance(b, dict) and b.get('type') == 'text' and as_str(b.get('text')).strip()
            ]
            if texts:
                return ' '.join(' '.join(texts).split())
    return ''


def schemaSummarize(
    messages: list[dict[str, object]],
    priorSummaryTexts: list[str] | None = None,
    goalHint: str = '',
    maxChars: int = SUMMARY_CAP_TOKENS * 4,
) -> str:
    """Fixed-schema markdown summary (deterministic, no LLM).

    Sections: Goal / Constraints / Progress (Done·In-Progress·Blocked) /
    Key Decisions / Next Steps / Critical Context / <read-files> /
    <modified-files>. The file ledger is carried forward across repeated
    compactions by merging prior summaries' ledger tags with freshly
    observed tool calls.
    """
    goal = ' '.join((goalHint or '').split())[:400] or _firstUserText(messages)[:400] or '(not recorded)'

    done: list[str] = []
    blockers: list[str] = []
    lastPhase = ''
    lastStep: object = None
    for name, inp in _iterToolCalls(messages):
        if name != 'update_state':
            continue
        phase = as_str(inp.get('phase'))
        if phase:
            lastPhase = phase
            lastStep = inp.get('step')
        for c in as_str(inp.get('completed')).split('\n'):
            c = c.strip()
            if c and c not in done:
                done.append(c)
        latestBlockers = [b.strip() for b in as_str(inp.get('blockers')).split('\n') if b.strip()]
        if latestBlockers:
            blockers = latestBlockers

    # Critical context: the latest failing receipt (first line), if any,
    # plus the carried-forward prose of earlier summaries (capped) so
    # repeated compactions don't silently drop older context.
    critical = ''
    for m in reversed(messages):
        if m.get('role') != 'tool':
            continue
        content = m.get('content')
        text = content if isinstance(content, str) else ''
        low = text.lower()
        if 'error:' in low or 'failed' in low or 'exit code: 1' in low:
            critical = ' '.join(text.split())[:300]
            break
    if priorSummaryTexts:
        import re as _re

        # Strip the ledger blocks from the carried-forward prose — leaving
        # them in would plant fake <read-files> tags inside Critical Context
        # that a later ledger parse would match first.
        earlier = '\n---\n'.join(priorSummaryTexts)
        earlier = _re.sub(r'<read-files>.*?</read-files>', '', earlier, flags=_re.DOTALL)
        earlier = _re.sub(r'<modified-files>.*?</modified-files>', '', earlier, flags=_re.DOTALL)
        earlier = ' '.join(earlier.split())[:600]
        if earlier:
            critical = (critical + '\n' if critical else '') + f'Earlier context: {earlier}'

    # Ledger: prior summaries first, then fresh observations (deduped).
    priorRead: list[str] = []
    priorModified: list[str] = []
    for t in priorSummaryTexts or []:
        r, w = _parseLedgerTags(t)
        for p in r:
            if p not in priorRead:
                priorRead.append(p)
        for p in w:
            if p not in priorModified:
                priorModified.append(p)
    freshRead, freshModified = extractFileLedger(messages)
    for p in freshModified:
        if p not in priorModified:
            priorModified.append(p)
        if p in priorRead:
            priorRead.remove(p)
    for p in freshRead:
        if p not in priorRead and p not in priorModified:
            priorRead.append(p)

    inProgress = f'phase={lastPhase} step={lastStep}' if lastPhase else '(not recorded)'
    lines: list[str] = [
        '## Goal',
        goal,
        '',
        '## Constraints',
        '(not recorded)',
        '',
        '## Progress',
        '- Done: ' + ('; '.join(done[:20]) if done else '(none recorded)'),
        f'- In progress: {inProgress}',
        '- Blocked: ' + ('; '.join(blockers[:10]) if blockers else '(none)'),
        '',
        '## Key Decisions',
        '(not recorded)',
        '',
        '## Next Steps',
        '(not recorded)',
        '',
        '## Critical Context',
        critical or '(none recorded)',
        '',
        '<read-files>',
        *priorRead[:100],
        '</read-files>',
        '',
        '<modified-files>',
        *priorModified[:100],
        '</modified-files>',
    ]
    out = '\n'.join(lines)
    if len(out) > maxChars:
        out = out[:maxChars] + '\n[... summary truncated at the token cap]'
    return out


# ── Compaction lock events (§9.3 #2: start/summary/end, TTL-guarded) ──


def acquireCompactionLock(session: object, ttl: float = LOCK_TTL_S) -> bool:
    """Acquire the session's compaction lock; False when held.

    A lock older than ``ttl`` is orphaned (mid-compaction crash) and is
    re-acquired so compaction is never blocked forever.
    """
    import logging
    import time as _time

    now = _time.time()
    lock = getattr(session, '_compaction_lock', None)
    if isinstance(lock, dict):
        started = float(lock.get('startedAt') or 0.0)
        if now - started < ttl:
            return False
        logging.getLogger(__name__).warning(
            'compaction lock orphaned (age %.0fs > TTL %.0fs) — re-acquiring', now - started, ttl
        )
    try:
        session._compaction_lock = {'startedAt': now, 'phase': 'start'}  # type: ignore[attr-defined]
    except Exception:
        return True
    logging.getLogger(__name__).info('compaction lock start session=%s', getattr(session, 'id', '?'))
    return True


def noteCompactionPhase(session: object, phase: str) -> None:
    """Record a lock phase transition (start → summary → end)."""
    import logging

    lock = getattr(session, '_compaction_lock', None)
    if isinstance(lock, dict):
        lock['phase'] = phase
    logging.getLogger(__name__).info('compaction phase=%s session=%s', phase, getattr(session, 'id', '?'))


def releaseCompactionLock(session: object) -> None:
    import logging

    try:
        session._compaction_lock = None  # type: ignore[attr-defined]
    except Exception:
        pass
    logging.getLogger(__name__).info('compaction lock end session=%s', getattr(session, 'id', '?'))


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
    contextWindow: int | None = None,
    retainRatio: float = COMPACT_RETAIN_RATIO,
    summaryCapTokens: int = SUMMARY_CAP_TOKENS,
    goalHint: str = '',
    schema: bool = False,
) -> list[dict[str, object]]:
    """Compress messages to fit within a token threshold by summarizing the middle.

    Preserves head messages and a verbatim tail, summarizing everything in
    between. Two tail modes:

    * token-budgeted (prune-then-compact §9.3 #2): when ``contextWindow`` is
      given, the tail keeps the newest ``retainRatio × contextWindow`` tokens
      word-for-word instead of a fixed message count;
    * count-budgeted (legacy): ``tail_count`` messages.

    Boundaries are tool-pair-safe: an assistant tool-call message and its
    tool results form one atomic unit, so a tool result is never orphaned
    from its call (wire-format safety). With ``schema=True`` the summary
    uses the fixed markdown schema (Goal/Constraints/Progress/Key
    Decisions/Next Steps/Critical Context/<read-files>/<modified-files>) and
    carries the file ledger forward across repeated compactions; the summary
    text is capped at ``summaryCapTokens`` (≈4 chars/token), splitting the
    middle into two summaries and merging when one alone would exceed it.

    Args:
        messages: Full conversation messages.
        threshold: Token threshold to compress under.
        head_count: Number of messages to preserve at the start.
        tail_count: Number of messages to preserve at the end (count mode).
        summarizer: Optional callable — sync or async — that returns a summary
            string; awaited transparently. ``localSummarize`` is the default.
        pin_predicates: Optional predicates marking MIDDLE messages as
            landmarks to keep verbatim (e.g. the latest update_state
            transition, a failing verification receipt). At most
            ``max_pinned`` landmarks are retained.
        contextWindow: Model context window in tokens; enables the
            token-budgeted verbatim tail.
        retainRatio: Fraction of the window retained verbatim (tail).
        summaryCapTokens: Hard cap for the summary text, in tokens.
        goalHint: Session goal forwarded to the schema summarizer.
        schema: Use the fixed markdown schema for deterministic summaries.

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

    # Tool-pair-safe split: group into atomic units, then take head units,
    # tail units (token- or count-budgeted), and summarize the middle.
    units = _splitUnits(nonSystem)
    headUnits: list[list[dict[str, object]]] = []
    headMsgCount = 0
    idx = 0
    while idx < len(units) and headMsgCount < head_count:
        headUnits.append(units[idx])
        headMsgCount += len(units[idx])
        idx += 1
    tailUnits: list[list[dict[str, object]]] = []
    tailMsgCount = 0
    jdx = len(units)
    if contextWindow:
        tailBudget = int(contextWindow * retainRatio)
        acc = 0
        while jdx > idx:
            unit = units[jdx - 1]
            unitTokens = estimateTokens(unit)
            if tailUnits and acc + unitTokens > tailBudget:
                break
            jdx -= 1
            tailUnits.insert(0, unit)
            acc += unitTokens
            tailMsgCount += len(unit)
    else:
        while jdx > idx and tailMsgCount < tail_count:
            jdx -= 1
            tailUnits.insert(0, units[jdx])
            tailMsgCount += len(units[jdx])
    if jdx <= idx:
        # Head and tail consumed everything — nothing left to summarize.
        return list(messages)
    head = [m for u in headUnits for m in u]
    tail = [m for u in tailUnits for m in u]
    middle = [m for u in units[idx:jdx] for m in u]
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

    summaryMaxChars = summaryCapTokens * 4

    async def _summarize(chunk: list[dict[str, object]]) -> str:
        if summarizer:
            text = summarizer(chunk)
            if inspect.isawaitable(text):
                text = await text
            return as_str(text)
        if schema:
            return schemaSummarize(chunk, priorSummaryTexts, goalHint, maxChars=summaryMaxChars)
        return localSummarize(chunk)

    summaryText = await _summarize(middle)
    # Split-and-merge: a single turn alone can exceed the summary budget —
    # summarize two halves and merge instead of losing the excess silently.
    if len(summaryText) > summaryMaxChars and len(middle) >= 2:
        half = len(middle) // 2
        first = await _summarize(middle[:half])
        second = await _summarize(middle[half:])
        summaryText = first + '\n---\n' + second
    if len(summaryText) > summaryMaxChars:
        summaryText = summaryText[:summaryMaxChars] + '\n[... summary truncated at the token cap]'
    if priorSummaryTexts and not schema:
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
