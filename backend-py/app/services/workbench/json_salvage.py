"""Tolerant salvage for model-written JSON tool arguments.

Models (especially weak ones) wrap tool arguments in code fences, prefix
them with prose, or trail text after the JSON. Strict ``json.loads`` fails
on all of these; salvage extracts a parseable JSON object before the
harness escalates to the validation-error self-heal loop.
"""

from __future__ import annotations

import json
import re

_FENCE_RE = re.compile(r'```(?:json)?\s*(.*?)```', re.DOTALL | re.IGNORECASE)


def salvage_json_object(raw: str) -> dict | None:
    """Best-effort parse of a model-written JSON object.

    Strategy, in order:
      1. strict ``json.loads`` (callers already tried; retried cheaply here)
      2. strip `````json```` fences and retry the body
      3. slice from the first opening brace to the last closing brace
      4. drop a trailing comma before the close (common with token sampling)

    Only complete JSON objects are accepted — a wrong-but-valid parse must
    not reach a tool. Returns ``None`` when nothing salvageable remains.
    """
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except (json.JSONDecodeError, TypeError, ValueError):
        pass

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
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
    return None
