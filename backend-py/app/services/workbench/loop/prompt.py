"""Request-surface text shaping for the model (P1#11 split).

Moved from workbench.py VERBATIM: the tools-fallback note, the tool-block
reader, the strip-tools-from-history rewrite (a gateway that rejects the
request WITH tools gets one stripped retry), the tool-result truncation
discipline, the stage-B output spill (verbatim file + inline head/tail
preview), the tool-use-refusal detector, the ``[TOOLCALL] name|json`` text
tool protocol, and the assistant-text setter.

Nothing here reaches back into workbench.py. workbench.py re-exports every
name under its original name, so the loop body and the tests (which read
the spill constants via ``wb.``) keep resolving them there.

One-way import rule: nothing under loop/ imports workbench.py.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import cast

from app.json_narrowing import as_str
from app.services.workbench.sessions import WorkbenchSession
from app.type_aliases import JsonValue

logger = logging.getLogger('workbench')


# ── Tools-fallback retry ────────────────────────────────────
# A gateway that rejects the request WITH tools (deterministic 500s on
# unknown/aggregator models — the reported "always 500 while other harnesses
# work" class) will reject every identical retry too. One stripped retry
# gives the turn a way out. The model is told why tools vanished so it
# answers in plain text instead of narrating calls it cannot make.

_TOOLS_FALLBACK_NOTE = (
    '[Proxy Self-Heal] The tool transport failed upstream for this model, so tools '
    'are unavailable for this reply. Answer in plain text; if action is needed, '
    'describe the exact commands or edits for the user to run.'
)


def _toolBlockText(content: object) -> str:
    """Best-effort flat text for a tool result's inner content."""
    if isinstance(content, list):
        parts = [
            as_str(b.get('text'), '')
            for b in content
            if isinstance(b, dict) and b.get('type') == 'text'
        ]
        return '\n'.join(p for p in parts if p) or json.dumps(content, default=str)
    if isinstance(content, str):
        return content
    return json.dumps(content, default=str) if content is not None else ''


def _stripToolsFromHistory(messages: list[dict[str, object]]) -> list[dict[str, object]]:
    """Flatten tool-call history for a tools-fallback retry.

    Strict gateways reject tool-role messages / tool_use blocks when no
    ``tools`` array is declared, so the stripped request must carry a
    tool-less history too: tool results become user-role text, assistant
    ``tool_calls``/``tool_use`` blocks are dropped. The original working list
    is not mutated — the flattened copy feeds the wire request only. The
    self-heal note is merged into the last user message (Anthropic requires
    strict role alternation; a trailing user note must not sit beside another).
    """
    out: list[dict[str, object]] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = as_str(msg.get('role'), '')
        content = msg.get('content')
        if role == 'tool':
            toolId = as_str(msg.get('tool_use_id'), '') or as_str(msg.get('tool_call_id'), '') or 'tool'
            out.append(
                {
                    'role': 'user',
                    'content': f"[tool result for {toolId}]\n{_toolBlockText(content)}",
                }
            )
            continue
        if role == 'assistant':
            if msg.get('tool_calls'):
                cleaned = {k: v for k, v in msg.items() if k != 'tool_calls'}
                cleaned['content'] = as_str(content, '')
                out.append(cleaned)
                continue
            if isinstance(content, list):
                kept = [
                    b
                    for b in content
                    if isinstance(b, dict) and as_str(b.get('type'), '') not in ('tool_use', 'tool_result')
                ]
                out.append({**msg, 'content': kept})
                continue
            out.append(dict(msg))
            continue
        if role == 'user' and isinstance(content, list):
            if any(
                isinstance(b, dict) and as_str(b.get('type'), '') == 'tool_result'
                for b in content
            ):
                texts: list[str] = []
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if as_str(b.get('type'), '') == 'tool_result':
                        texts.append(f"[tool result]\n{_toolBlockText(b.get('content'))}")
                    elif as_str(b.get('type'), '') == 'text':
                        texts.append(as_str(b.get('text'), ''))
                out.append({'role': 'user', 'content': '\n\n'.join(t for t in texts if t) or '[tool result]'})
                continue
        out.append(dict(msg))
    for m in reversed(out):
        if as_str(m.get('role')) == 'user':
            c = m.get('content')
            if isinstance(c, list):
                m['content'] = [*c, {'type': 'text', 'text': _TOOLS_FALLBACK_NOTE}]
            else:
                m['content'] = f"{as_str(c, '')}\n\n{_TOOLS_FALLBACK_NOTE}"
            break
    else:
        out.append({'role': 'user', 'content': _TOOLS_FALLBACK_NOTE})
    return out


def _truncateToolOutput(text: str, cap: int) -> tuple[str, bool]:
    """Bounded head+tail tool-output truncation.

    Keeps a bounded HEAD and TAIL of the output with an explicit omission
    marker between them — the tail carries final results (test summaries,
    exit codes, last error) that a head-only cut discards. Prefers
    newline/JSON-boundary cuts so the fragments stay parseable.
    Single-line overrun guard (a documented field incident: one line longer
    than the byte budget made the truncation routine return empty): when the
    boundary cut would leave almost nothing, fall back to the hard cut — a
    mid-token fragment beats no content, and the marker always states how
    many characters were omitted. Returns ``(trimmed, truncated)``.
    """
    if len(text) <= cap:
        return text, False
    markerReserve = 80
    budget = max(cap - markerReserve, cap // 2)
    headBudget = (budget * 3) // 4
    tailBudget = budget - headBudget
    headCut = text[:headBudget]
    boundary = max(headCut.rfind('\n'), headCut.rfind('\r'))
    if boundary <= headBudget // 2:
        for ch in (',', '}'):
            idx = headCut.rfind(ch)
            if idx > headBudget // 2:
                boundary = idx
                break
    head = headCut[:boundary] if boundary > 0 else headCut
    if len(head) < min(64, max(1, headBudget // 16)):
        # T16(c) overrun guard: no usable boundary — degrade to the hard
        # head cut rather than emitting a near-empty fragment.
        return text[:cap], True
    tailSlice = text[-tailBudget:] if tailBudget > 0 else ''
    newline = tailSlice.find('\n')
    if 0 <= newline < len(tailSlice) // 2:
        tailSlice = tailSlice[newline + 1 :]
    omitted = len(text) - len(head) - len(tailSlice)
    marker = f'\n[... {omitted} characters omitted ...]\n'
    return head + marker + tailSlice, True


# ── Output-cap discipline, stage B: spill ──
# A fresh tool result larger than the threshold is stored verbatim in a
# session-scoped file and replaced inline by a head/tail preview that fits
# the 30 KB / 2000-line model-facing budget. Stage B runs on FRESH results
# only; historical results are pruned at compaction time (stage A, #2).
_SPILL_THRESHOLD_CHARS = 50 * 1024
# Tools that can still get the full bytes back after a spill. A spilled file is
# only worth spilling when the model holding the receipt can open it (or hand
# off to something that can), so this is the checklist for stage B — kept here,
# next to the threshold it conditions, rather than as a second copy elsewhere.
_SPILL_RETRIEVAL_TOOLS = frozenset({'read_file', 'read_files', 'list_directory', 'spawn_subagents'})
_SPILL_HEAD_CHARS = 15 * 1024
_SPILL_TAIL_CHARS = 15 * 1024
_SPILL_HEAD_LINES = 1000
_SPILL_TAIL_LINES = 1000
SPILL_FILE_DIR = '.aug/spill'


def spill_file_relpath(sessionId: str, seq: int, toolName: str) -> str:
    """Workspace-relative spill path for one session's Nth spilled result."""
    safe = re.sub(r'[^A-Za-z0-9_.-]', '_', as_str(sessionId or '').strip()) or 'session'
    safeTool = re.sub(r'[^A-Za-z0-9_.-]', '_', as_str(toolName or '').strip()) or 'tool'
    return f'{SPILL_FILE_DIR}/{safe}/{seq:04d}-{safeTool}.txt'


def _splitSpillPreview(text: str) -> tuple[str, str, int]:
    """Head/tail preview within the char+line budgets (stage B).

    Works in code points and never splits a surrogate pair: a dangling high
    surrogate at the head cut (or low surrogate at the tail cut) is dropped.
    Returns ``(head, tail, omittedChars)``.
    """
    head = text[:_SPILL_HEAD_CHARS]
    headLines = head.split('\n')
    if len(headLines) > _SPILL_HEAD_LINES:
        head = '\n'.join(headLines[:_SPILL_HEAD_LINES])
    tail = text[-_SPILL_TAIL_CHARS:]
    tailLines = tail.split('\n')
    if len(tailLines) > _SPILL_TAIL_LINES:
        tail = '\n'.join(tailLines[-_SPILL_TAIL_LINES:])
    if head and '\ud800' <= head[-1] <= '\udbff':
        head = head[:-1]
    if tail and '\udc00' <= tail[0] <= '\udfff':
        tail = tail[1:]
    omitted = len(text) - len(head) - len(tail)
    return head, tail, omitted


def _spillToolResult(
    session: WorkbenchSession, toolName: str, result: str, retrievable: bool = True
) -> str | None:
    """Stage B: spill an oversized fresh result to a session-scoped file.

    Returns the inline replacement (head/tail preview + one notice line with
    the omitted byte count, the storage locator, and a retrieval hint), or
    None when spilling is not possible (no workspace, write failure) so the
    caller falls through to ordinary truncation.

    ``retrievable`` is the caller's answer to "can this model still read the
    file back?" A receipt that names a path is a trap when the offered tool
    surface has no reader and no subagent: the model spends a round trying to
    obey it, then concludes the output is gone. Without a retrieval route there
    is nothing to spill *for*, so the caller truncates honestly instead.
    """
    if not retrievable:
        return None
    workspace = as_str(getattr(session, 'workspacePath', None) or '').strip()
    if not workspace:
        return None
    try:
        seq = int(getattr(session, '_spillSeq', 0) or 0) + 1
        # Claim the sequence number BEFORE writing, so two oversized
        # results in one batch can't compute the same seq and overwrite each
        # other's file (the preview's "stored at …" then pointed at wrong bytes).
        session._spillSeq = seq  # type: ignore[attr-defined]
        relPath = spill_file_relpath(as_str(getattr(session, 'id', '') or ''), seq, toolName)
        absPath = os.path.normpath(os.path.join(workspace, *relPath.split('/')))
        os.makedirs(os.path.dirname(absPath), exist_ok=True)
        with open(absPath, 'w', encoding='utf-8', errors='replace', newline='') as f:
            f.write(result)
    except OSError:
        logger.debug('tool-result spill failed session=%s tool=%s', getattr(session, 'id', ''), toolName, exc_info=True)
        return None
    head, tail, omitted = _splitSpillPreview(result)
    notice = (
        f'[... {omitted} characters omitted — full output stored at {relPath}. '
        'Retrieve it with read_file on that path, or delegate scanning it to an explore subagent. '
        'Until you do, this preview is the only part you have seen: do not report the omitted '
        'portion as evidence.]'
    )
    return f'{head}\n{notice}\n{tail}'


# Refusal patterns: a model claiming it cannot use tools despite being
# offered them (or hosted on a gateway that silently drops `tools`). Narrow
# by design — "as an AI" prose must not false-positive.
_REFUSAL_RE = re.compile(
    r"((?:i|we) (?:can't|cannot|am|are) (?:unable to|not able to|not allowed to) (?:use|run|execute|access) tools?"
    r"|(?:i|we) (?:don't|do not|can't|cannot) (?:have|get) (?:access to|to use) tools?"
    r"|no tools? (?:are )?available"
    r"|tool (?:use|access|usage) (?:is|isn't|is not) (?:not )?(?:available|enabled|supported)"
    r"|i have no tools?)",
    re.IGNORECASE,
)


def _isToolRefusal(text: str) -> bool:
    """True when the assistant text reads as a tool-use refusal."""
    return bool(_REFUSAL_RE.search(text or ''))


# Text tool protocol: models that ignore native `tools` (or gateways that
# silently drop them) call tools via `[TOOLCALL] name|json` lines — one per
# line, mirroring smolagents text-protocol patterns.
_TEXT_TOOLCALL_RE = re.compile(
    r'^\[TOOLCALL\]\s+([A-Za-z0-9_.-]+)\s*\|\s*(.*)$', re.IGNORECASE | re.MULTILINE
)


def _parseTextToolCalls(text: str) -> list[tuple[str, dict[str, object]]]:
    """Parse ``[TOOLCALL] name|json`` protocol lines into (name, args) pairs."""
    calls: list[tuple[str, dict[str, object]]] = []
    if not text:
        return calls
    for m in _TEXT_TOOLCALL_RE.finditer(text):
        name = m.group(1)
        raw = m.group(2).strip()
        from app.services.workbench.json_salvage import salvage_json_object

        saved = salvage_json_object(raw) if raw else {}
        if saved is not None:
            calls.append((name, saved))
        else:
            # Unsalvageable garbage must never execute as {} — mark it so the
            # loop's validation path surfaces an error (mirrors the native
            # tool-call _raw handling; audit finding).
            calls.append((name, {'_raw': raw}))
    return calls


def _stripTextToolCallLines(text: str) -> str:
    """Remove protocol lines from assistant text before it enters history."""
    lines = [
        ln for ln in (text or '').splitlines() if not _TEXT_TOOLCALL_RE.match(ln.strip())
    ]
    return '\n'.join(lines).strip()


def _setAssistantText(
    assistantMsg: dict[str, object],
    text: str,
    isAnthropic: bool,
    contentBlocks: list[dict[str, object]] | None = None,
) -> None:
    """Replace the assistant message's text payload (both wire formats)."""
    if isAnthropic and contentBlocks is not None:
        for b in contentBlocks:
            if isinstance(b, dict) and as_str(b.get('type'), '') == 'text':
                b['text'] = text
        assistantMsg['content'] = cast(JsonValue, contentBlocks)
    else:
        assistantMsg['content'] = text
