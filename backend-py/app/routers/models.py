"""Model listing API routes.

Port of model-list.js aggregation + Express routes.
"""

from __future__ import annotations

from fastapi import APIRouter, Query

from app.services import model_service

router = APIRouter()


@router.get("/api/models")
async def list_models(
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
        models = models[offset:offset + limit]
    return {"models": models, "hasMore": (offset + limit) < total, "total": total}


@router.get("/v1/models")
async def openai_models():
    """OpenAI-compatible model list (no pagination)."""
    models = await model_service.aggregate()
    return {
        "object": "list",
        "data": [
            {
                "id": m["id"],
                "object": "model",
                "created": 0,
                "owned_by": m.get("provider", "unknown"),
            }
            for m in models
        ],
    }
