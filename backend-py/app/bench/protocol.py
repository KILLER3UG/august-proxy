"""B0/T9 — headless protocol conventions for ``august-bench``.

The board adapters consume exactly this shape, so the JSONL stream is
lossless by design: every workbench event that matters is mapped onto a
typed envelope, one JSON object per line.

Typed exit codes (T9):
  0  ok           — the run finished and produced a final answer
  1  error        — the run failed (provider error, crash, budget error)
  42 input        — bad CLI input (missing task, unreadable schema, ...)
  53 turn-limit   — the turn/round budget was exhausted
"""

from __future__ import annotations

import json
import time
from typing import Any, TextIO

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_INPUT = 42
EXIT_TURN_LIMIT = 53

EXIT_NAMES = {
    EXIT_OK: 'ok',
    EXIT_ERROR: 'error',
    EXIT_INPUT: 'input',
    EXIT_TURN_LIMIT: 'turn-limit',
}

# Workbench emit types that are dropped from the bench stream (UI-only chrome
# or duplicates of events we already record). Everything else is forwarded.
_DROPPED_WORKBENCH_TYPES = frozenset({
    'circuitMode',
    'recurringTask',
    'userMessageInjected',
})


def bench_event(event_type: str, **payload: Any) -> dict[str, Any]:
    """One typed envelope: ``{type, ts, ...payload}`` (ts = UTC ISO-8601)."""
    return {
        'type': event_type,
        'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        **payload,
    }


class JsonlWriter:
    """Line-oriented JSONL sink (stdout or a file). Flush per event so a
    crashed run still leaves a complete, parseable stream behind."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream

    def write(self, event_type: str, **payload: Any) -> dict[str, Any]:
        event = bench_event(event_type, **payload)
        self._stream.write(json.dumps(event, ensure_ascii=False, default=str) + '\n')
        self._stream.flush()
        return event


def map_workbench_event(ev: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """Map one workbench emit onto a bench envelope.

    Returns ``(bench_type, payload)`` or None when the event is UI chrome
    that carries no information for a board adapter.
    """
    etype = str(ev.get('type') or '')
    if not etype or etype in _DROPPED_WORKBENCH_TYPES:
        return None
    payload = {k: v for k, v in ev.items() if k != 'type'}
    mapping = {
        'started': 'run/model',
        'tool_use': 'step/tool_call',
        'toolResult': 'step/tool_result',
        'finalOutput': 'step/assistant',
        'compaction': 'context/compaction',
        'contextPressure': 'context/pressure',
        'retrying': 'run/retry',
        'warning': 'run/warning',
        'error': 'run/error',
        'planProposed': 'step/plan',
        'clarifyProposed': 'step/clarify',
        'done': 'run/done',
    }
    return mapping.get(etype, f'workbench/{etype}'), payload


def validate_against_schema(value: Any, schema: dict[str, Any]) -> tuple[bool, str]:
    """Minimal JSON-Schema subset validator (no external dependency).

    Supports the keywords boards actually use for final answers: ``type``
    (object/array/string/number/integer/boolean/null), ``required``,
    ``properties``, ``items``, ``enum``. Unknown keywords are ignored —
    validation is best-effort by design, but a type/required/enum mismatch
    fails the answer. Returns ``(ok, reason)``.
    """
    return _validate_node(value, schema, '$')


def _json_type(value: Any) -> str:
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'boolean'
    if isinstance(value, int):
        return 'integer'
    if isinstance(value, float):
        return 'number'
    if isinstance(value, str):
        return 'string'
    if isinstance(value, list):
        return 'array'
    if isinstance(value, dict):
        return 'object'
    return 'unknown'


def _type_matches(actual: str, expected: str) -> bool:
    if actual == expected:
        return True
    # An integer satisfies "number"; nothing else crosses types.
    return expected == 'number' and actual == 'integer'


def _validate_node(value: Any, schema: dict[str, Any], path: str) -> tuple[bool, str]:
    if not isinstance(schema, dict):
        return True, ''
    expected = schema.get('type')
    if isinstance(expected, str):
        actual = _json_type(value)
        if not _type_matches(actual, expected):
            return False, f'{path}: expected {expected}, got {actual}'
    elif isinstance(expected, list):
        actual = _json_type(value)
        if not any(_type_matches(actual, str(t)) for t in expected):
            return False, f'{path}: expected one of {expected}, got {actual}'
    if 'enum' in schema and isinstance(schema['enum'], list):
        if value not in schema['enum']:
            return False, f'{path}: value not in enum {schema["enum"][:8]}'
    if isinstance(value, dict):
        required = schema.get('required')
        if isinstance(required, list):
            for key in required:
                if isinstance(key, str) and key not in value:
                    return False, f'{path}: missing required key {key!r}'
        properties = schema.get('properties')
        if isinstance(properties, dict):
            for key, sub in properties.items():
                if key in value and isinstance(sub, dict):
                    ok, reason = _validate_node(value[key], sub, f'{path}.{key}')
                    if not ok:
                        return False, reason
    if isinstance(value, list):
        items = schema.get('items')
        if isinstance(items, dict):
            for i, item in enumerate(value):
                ok, reason = _validate_node(item, items, f'{path}[{i}]')
                if not ok:
                    return False, reason
    return True, ''


def parse_final_answer(text: str, schema: dict[str, Any]) -> tuple[bool, Any, str]:
    """Extract + validate the final answer against ``--output-schema``.

    The answer must be (or contain) JSON. A fenced ```json block wins; then a
    bare JSON document; then the largest {...} span. Returns
    ``(ok, parsed, reason)``.
    """
    raw = (text or '').strip()
    if not raw:
        return False, None, 'empty final answer'
    candidates: list[str] = []
    if '```' in raw:
        for chunk in raw.split('```'):
            chunk = chunk.strip()
            if chunk.lower().startswith('json'):
                chunk = chunk[4:].strip()
            if chunk.startswith(('{', '[')):
                candidates.append(chunk)
    candidates.append(raw)
    start = raw.find('{')
    end = raw.rfind('}')
    if 0 <= start < end:
        candidates.append(raw[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        ok, reason = validate_against_schema(parsed, schema)
        if ok:
            return True, parsed, ''
        # Parsed JSON that fails the schema is reported, not retried against
        # looser candidates — the model answered, the answer just mismatches.
        return False, parsed, reason
    return False, None, 'final answer contains no parseable JSON'
