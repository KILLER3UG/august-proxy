"""
CamelCase Pydantic BaseModel — auto-converts between Python snake_case
and JSON camelCase. Frontend sends/receives camelCase, backend uses snake_case.

Usage:
    class MyModel(CamelModel):
        my_field: str
        created_at: str = ""

    # Accepts both:
    m = MyModel(**{"myField": "val", "createdAt": "now"})  # camelCase (frontend)
    m = MyModel(**{"my_field": "val", "created_at": "now"})  # snake_case (Python)

    # Serializes to camelCase:
    m.model_dump(by_alias=True)  # {"myField": "val", "createdAt": "now"}
"""

from __future__ import annotations

from typing import Any
from pydantic import BaseModel, ConfigDict


def _to_camel(snake: str) -> str:
    """Convert snake_case to camelCase."""
    parts = snake.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


class CamelModel(BaseModel):
    """Base model with automatic camelCase alias generation.

    - Accepts both camelCase (frontend) and snake_case (Python) on input
    - Use ``model_dump(by_alias=True)`` to serialize to camelCase for responses
    - Use ``model_dump()`` (default) to keep snake_case internally
    """

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=_to_camel,
    )


def camelize(data: Any) -> Any:
    """Convert a dict's keys from snake_case to camelCase recursively.

    Use for raw dict responses that aren't Pydantic models.
    """
    if isinstance(data, dict):
        return {_to_camel(k): camelize(v) for k, v in data.items()}
    if isinstance(data, list):
        return [camelize(item) for item in data]
    return data
