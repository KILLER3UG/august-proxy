"""
Bidirectional snake_case ↔ camelCase converters for dict keys.

Used at the Anthropic/OpenAI API boundary to translate between
internal camelCase code and external snake_case wire formats.
"""

from __future__ import annotations

from typing import Callable, cast

from app.type_aliases import JsonValue


def _snakeToCamelKey(key: str) -> str:
    """Convert a single snake_case key to camelCase."""
    parts = key.split('_')
    return parts[0] + ''.join((p.capitalize() for p in parts[1:]))


def _camelToSnakeKey(key: str) -> str:
    """Convert a single camelCase key to snake_case."""
    result = []
    for i, ch in enumerate(key):
        if ch.isupper():
            if i > 0:
                result.append('_')
            result.append(ch.lower())
        else:
            result.append(ch)
    return ''.join(result)


# JSON Schema payloads must stay VERBATIM (B1): OpenAI tool defs carry the
# schema under `parameters`, Anthropic under `input_schema`. Their keys are
# schema KEYWORDS (additionalProperties, minLength, …), not API casing —
# recursively renaming them produced corrupted schemas on strict gateways
# (`additionalProperties` → `additional_properties` etc.).
_SCHEMA_PAYLOAD_KEYS = frozenset({'parameters', 'input_schema'})

# Anthropic tool_use / tool_result blocks carry model- or client-generated
# argument objects under `input`. Those keys are the tool's OWN argument names
# (camelCase by convention) — renaming them to snake_case makes the round-2
# upstream body contradict the tool definitions sent verbatim, and corrupts
# any consumer that reads those args.
_TOOL_BLOCK_TYPES = frozenset({'tool_use', 'tool_result'})


def _convert(obj: JsonValue, key_fn: Callable[[str], str]) -> JsonValue:
    """Recursively convert dict keys, leaving schema/tool-arg payloads untouched."""
    if isinstance(obj, dict):
        out: dict[str, object] = {}
        for k, v in obj.items():
            if k in _SCHEMA_PAYLOAD_KEYS or (k == 'input' and obj.get('type') in _TOOL_BLOCK_TYPES):
                out[key_fn(k)] = v
            else:
                out[key_fn(k)] = _convert(cast(JsonValue, v), key_fn)
        return out
    if isinstance(obj, list):
        return [_convert(item, key_fn) for item in obj]
    return obj


def strip_none_deep(obj: JsonValue) -> JsonValue:
    """Recursively drop ``None`` values so strict upstream validators never see them.

    ``exclude_none`` at dump time only cleans the top level; nested ``None``
    (e.g. ``content: null`` on a message, a null tool argument) still reaches
    upstream and 400s strict gateways (the 0.12.21 session_id incident class).
    ``None`` is never meaningful in these wire formats — safe to drop at any
    depth, and idempotent.
    """
    if isinstance(obj, dict):
        return {k: strip_none_deep(cast(JsonValue, v)) for k, v in obj.items() if v is not None}
    if isinstance(obj, list):
        return [strip_none_deep(item) for item in obj]
    return obj


def snakeToCamel(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from snake_case to camelCase.

    Schema payloads (``parameters`` / ``input_schema`` subtrees) are passed
    through unchanged — their keys are JSON Schema keywords, not API casing.
    """
    return _convert(obj, _snakeToCamelKey)


def camelToSnake(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from camelCase to snake_case.

    Schema payloads (``parameters`` / ``input_schema`` subtrees) are passed
    through unchanged — their keys are JSON Schema keywords, not API casing.
    """
    return _convert(obj, _camelToSnakeKey)
