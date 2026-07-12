"""Model listing API routes.

Port of model-list.js aggregation + Express routes.

Response models inherit from :class:`CamelModel` so internal attributes
stay snake_case while the JSON sent to the frontend remains camelCase
(see ``app/models/camel_base.py``). The aggregation logic in
``model_service`` is untouched; only the return shape is wrapped.
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import ConfigDict
from pydantic.alias_generators import to_camel

from app.models.camel_base import CamelModel
from app.services import model_service

router = APIRouter()


class ModelInfo(CamelModel):
    """A single provider model, exposed with camelCase JSON keys.

    ``extra='allow'`` preserves any provider-specific fields returned by
    ``model_service.aggregate`` that are not modelled explicitly, so the
    serialized output matches the previous dict-based response exactly.
    """

    id: str
    provider: str = ""
    context_window: int | None = None
    display_name: str | None = None

    model_config = ConfigDict(
        extra="allow",
        alias_generator=to_camel,
        populate_by_name=True,
    )


class ModelList(CamelModel):
    """Aggregated model listing response."""

    models: list[ModelInfo]
    has_more: bool
    total: int


@router.get('/api/models', response_model=ModelList)
async def listModels(
    refresh: bool = Query(False),
    limit: int = Query(0),
    offset: int = Query(0),
):
    """Aggregated model list from all providers.

    Fetches from each provider's /models endpoint with fallback
    to static lists. Results are cached for 5 minutes.
    """
    models = await model_service.aggregate(refresh=refresh)
    total = len(models)
    if limit > 0:
        models = models[offset : offset + limit]
    return ModelList(
        models=[ModelInfo(**m) for m in models],
        has_more=offset + limit < total,
        total=total,
    )


@router.get('/v1/models')
async def openaiModels():
    """OpenAI-compatible model list (no pagination)."""
    models = await model_service.aggregate()
    return {
        'object': 'list',
        'data': [
            {
                'id': m['id'],
                'object': 'model',
                'created': 0,
                'owned_by': m.get('provider', 'unknown'),
            }
            for m in models
        ],
    }