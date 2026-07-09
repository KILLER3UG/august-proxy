"""Shared base models & type aliases for provider payloads.

This module establishes the Pydantic foundation for the layered model
approach documented in PHASE2_TYPE_REMEDIATION_PLAN.md:

    Layer 1 — Boundary (dict[str, JsonValue] / extra="allow")
    Layer 2 — Routing & tool models (strict Pydantic)
    Layer 3 — Internal state & accumulators (JsonValue)

Design principle (proxy-specific):
    Strict on what you touch, ``extra="allow"`` on what you forward.
"""
from __future__ import annotations

from typing import TypeAlias

from pydantic import BaseModel, ConfigDict

# Re-export JsonValue from the canonical home in typeAliases so that model
# code doesn't need to import from two places.
JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]


class ExtraAllowBaseModel(BaseModel):
    """Base for provider payload models.

    Extra fields are accepted (not rejected) so that an upstream provider
    adding a new field doesn't break August. Fields we *act on* are typed
    explicitly; everything else passes through as raw JSON.
    """
    model_config = ConfigDict(extra="allow", populate_by_name=True)


class BaseRequest(ExtraAllowBaseModel):
    """Minimal shared request — every provider has at least a model and stream flag."""
    model: str
    stream: bool = False
