"""
Bidirectional snake_case ↔ camelCase converters for dict keys.

Used at the Anthropic/OpenAI API boundary to translate between
internal camelCase code and external snake_case wire formats.
"""
from __future__ import annotations
from app.typeAliases import JsonValue

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

def snakeToCamel(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from snake_case to camelCase."""
    if isinstance(obj, dict):
        return {_snakeToCamelKey(k): snakeToCamel(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [snakeToCamel(item) for item in obj]
    return obj

def camelToSnake(obj: JsonValue) -> JsonValue:
    """Recursively convert all dict keys from camelCase to snake_case."""
    if isinstance(obj, dict):
        return {_camelToSnakeKey(k): camelToSnake(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [camelToSnake(item) for item in obj]
    return obj