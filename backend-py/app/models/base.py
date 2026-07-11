"""Shared base models & type aliases for provider payloads.

This module establishes the Pydantic foundation for the layered model
approach documented in PHASE2_TYPE_REMEDIATION_PLAN.md:

    Layer 1 — Boundary (dict[str, object] / extra="allow")
    Layer 2 — Routing & tool models (strict Pydantic)
    Layer 3 — Internal state & accumulators (JsonValue)

Design principle (proxy-specific):
    Strict on what you touch, ``extra="allow"`` on what you forward.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

# Re-export JsonValue from the canonical home in typeAliases so that model
# code doesn't need to import from two places. Defined as a PEP 695 type alias
# (``type JsonValue = ...``) so pydantic 2.13 can resolve the self-reference.
type JsonValue = str | int | float | bool | None | list[JsonValue] | dict[str, object]


class ExtraAllowBaseModel(BaseModel):
    """Base for provider payload models.

    Extra fields are accepted (not rejected) so that an upstream provider
    adding a new field doesn't break August. Fields we *act on* are typed
    explicitly; everything else passes through as raw JSON.

    Fields use snake_case in Python code but serialize/deserialize as
    camelCase via ``alias_generator=to_camel``. The ``populate_by_name=True``
    setting allows both the Python name and the alias to work.
    """

    model_config = ConfigDict(extra='allow', populate_by_name=True, alias_generator=to_camel)


class BaseRequest(ExtraAllowBaseModel):
    """Minimal shared request — every provider has at least a model and stream flag."""

    model: str
    stream: bool = False
