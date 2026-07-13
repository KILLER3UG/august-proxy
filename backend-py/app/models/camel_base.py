"""Shared Pydantic base for API models with camelCase JSON boundary.

This is the Pydantic-level mechanism for the snake_case <-> camelCase
boundary. It is intentionally separate from
``app/adapters/caseConverters.py``, which is a plain *string* converter
(camelCase string <-> snake_case string) used for ad-hoc dict key
translation. The two coexist: ``caseConverters`` mutates dict keys;
``CamelModel`` defines model fields in snake_case and serializes them to
camelCase JSON via an alias generator.

Rule: new API request/response models inherit from ``CamelModel`` instead
of ``pydantic.BaseModel``. Internal attributes stay snake_case; JSON
in/out stays camelCase, so the frontend (which speaks camelCase) is
unaffected.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Base for any Pydantic model exposed over the API.

    Internal attributes stay snake_case; JSON in/out is camelCase.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
    )
