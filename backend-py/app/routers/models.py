"""
Model listing API routes.
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
    """Aggregated model list from all providers."""
    models = model_service.aggregate()
    if limit > 0:
        models = models[offset:offset + limit]
    return {"models": models, "hasMore": False, "total": len(models)}


@router.get("/v1/models")
async def openai_models():
    """OpenAI-compatible model list."""
    models = model_service.aggregate()
    return {
        "object": "list",
        "data": [
            {"id": m["id"], "object": "model", "created": 0, "owned_by": m.get("provider", "unknown")}
            for m in models
        ],
    }
