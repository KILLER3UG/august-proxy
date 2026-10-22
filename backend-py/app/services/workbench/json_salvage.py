"""Tolerant salvage for model-written JSON tool arguments.

Models (especially weak ones) wrap tool arguments in code fences, prefix
them with prose, or trail text after the JSON. Strict ``json.loads`` fails
on all of these; salvage extracts a parseable JSON object before the
harness escalates to the validation-error self-heal loop.

The expensive class is not the fence — it is the Windows path. A model that
writes ``{"path": "C:\\Dev\\x"}`` with a single backslash produces text that
is not JSON at all, because ``\\D`` is not a valid escape. This app runs on
Windows, so every path a model echoes is one backslash away from a
deterministic ``[Validation Error]`` round.
"""

from __future__ import annotations

import json
import re

_FENCE_RE = re.compile(r'```(?:json)?\s*(.*?)```', re.DOTALL | re.IGNORECASE)

#: The escapes JSON itself defines, minus ``u`` (which needs four hex digits
#: and is checked separately).
_VALID_ESCAPES = frozenset('"\\/bfnrt')
_HEX = frozenset('0123456789abcdefABCDEF')


def _has_invalid_escape(body: str) -> bool:
    """Whether one string literal's body contains a backslash JSON cannot read."""
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch != '\\':
            i += 1
            continue
        nxt = body[i + 1] if i + 1 < n else ''
        if nxt == 'u' and len(body[i + 2 : i + 6]) == 4 and all(c in _HEX for c in body[i + 2 : i + 6]):
            i += 6
            continue
        if nxt in _VALID_ESCAPES:
            i += 2
            continue
        return True
    return False


def _literalize_backslashes(body: str) -> str:
    """Double every backslash in a body that has already been proved literal."""
    return body.replace('\\', '\\\\')


def _escape_controls(body: str) -> str:
    """Replace raw control characters with their JSON escape forms."""
    out: list[str] = []
    for ch in body:
        if ord(ch) < 0x20:
            out.append(json.dumps(ch)[1:-1])
        else:
            out.append(ch)
    return ''.join(out)


def repair_json_escapes(text: str) -> str:
    """Make a model's single-backslash string literals parseable.

    Walks the text the way a JSON parser does — outside a string nothing is
    touched, so a repair can never invent structure — and decides **per string
    literal**, which is the part that matters. A body containing at least one
    escape JSON cannot read (``\\D``, ``\\a``) proves the model was writing raw
    backslashes *in that value*, so every backslash in it becomes a literal one.
    A body whose escapes are all valid is left exactly as it is, because the
    common case is a ``write_file`` whose ``content`` legitimately carries
    ``a\\nb``: treating that proof-starved string as raw too would turn real
    newlines into the two characters ``\\n`` and ship a corrupted file.

    Raw control characters are escaped in either case — JSON forbids them inside
    a string and ``json.loads`` rejects them.

    Called only on text that already failed a strict parse, which keeps a valid
    document byte-identical. The limit that ships with the fix: a path segment
    whose letters happen to form a valid escape (``C:\\new\\file``) is
    indistinguishable from a value that means a newline and a form feed, so it
    stays one — but that document also parses strictly, so it was never this
    function's to repair.
    """
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch != '"':
            out.append(ch)
            i += 1
            continue
        # One string literal: find its closing quote the way a scanner does.
        j = i + 1
        while j < n:
            c = text[j]
            if c == '\\':
                j += 2
                continue
            if c == '"':
                break
            j += 1
        body = text[i + 1 : j]
        fixed = _escape_controls(_literalize_backslashes(body)) if _has_invalid_escape(body) else _escape_controls(body)
        out.append('"')
        out.append(fixed)
        out.append('"')
        if j >= n:
            return ''.join(out)  # unterminated literal: nothing more to decide
        i = j + 1
    return ''.join(out)


def _loads_repaired(text: str) -> dict | None:
    """Parse ``text``, then parse it once its escapes are repaired.

    The repair is tried only after the strict parse has already failed, which
    is what keeps a valid document byte-identical.
    """
    for candidate in (text, repair_json_escapes(text)):
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def salvage_json_object(raw: str) -> dict | None:
    """Best-effort parse of a model-written JSON object.

    Strategy, in order:
      1. strict ``json.loads`` (callers already tried; retried cheaply here)
      2. the same text with its string escapes repaired (:func:`repair_json_escapes`)
      3. strip `````json```` fences and retry the body
      4. slice from the first opening brace to the last closing brace
      5. drop a trailing comma before the close (common with token sampling)

    Only complete JSON objects are accepted — a wrong-but-valid parse must
    not reach a tool. Returns ``None`` when nothing salvageable remains.
    """
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    parsed = _loads_repaired(text)
    if parsed is not None:
        return parsed

    # Fenced blocks: ```json ... ``` — take the block body.
    m = _FENCE_RE.search(text)
    if m:
        return salvage_json_object(m.group(1))

    # Slice from the first opening brace to the LAST closing brace.
    for open_ch, close_ch in (('{', '}'), ('[', ']')):
        start = text.find(open_ch)
        if start == -1:
            continue
        end = text.rfind(close_ch)
        if end <= start:
            continue
        candidate = text[start : end + 1]
        # Trailing comma before the close is a common token-sampling slip.
        if candidate.endswith(',' + close_ch):
            candidate = candidate[:-2] + close_ch
        parsed = _loads_repaired(candidate)
        if parsed is not None:
            return parsed
    return None


def parse_tool_arguments(raw: str) -> dict:
    """Parse one model-written tool-argument blob, the whole way down.

    Strict first, then salvage, then the loop's own contract for a call that
    could not be read: ``{'_raw': text}``, which is what makes the caller answer
    ``[Validation Error]`` instead of executing a phantom argument-less call.

    This is the single door. The four accumulators that turn stream deltas into a
    tool call used to each hold their own ``json.loads`` + ``except`` — the two
    Anthropic bridge sites and the native stream accumulator had no salvage pass
    at all, so a Windows path written with one backslash failed there while the
    workbench round-trip would have repaired it. Same input, different verdict
    depending on which wire format a gateway happened to use is the bug this
    closes.
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        parsed = None
    if isinstance(parsed, dict):
        return parsed
    saved = salvage_json_object(raw)
    return saved if saved is not None else {'_raw': raw}
