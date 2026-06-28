"""
Configuration API routes.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.providers import resolver as provider_resolver
from app.lib import secrets
from app.services import config_service

router = APIRouter(prefix="/api/config")


@router.get("/activeProvider")
async def active_provider():
    """Get active provider and list all available providers.

    Only returns providers that have API keys configured —
    either built-in providers with keys in config.json/env vars,
    or custom providers from providers.json.
    """
    cfg = config_service.get_config()
    active = cfg.get("activeProvider")

    providers = []

    # Built-in providers that have API keys configured
    for p in provider_resolver.list_available():
        api_key = cfg.get(p["name"], {}).get("apiKey", "")
        if not api_key:
            from app.providers.clients import get_client
            client = get_client(p)
            if client:
                api_key = client.resolve_api_key() or ""
        if api_key:
            providers.append({
                "id": p["name"],
                "name": p["name"],
                "apiMode": p.get("api_mode", ""),
                "isAvailable": True,
                "redactedKey": secrets.mask(api_key),
            })

    # Custom providers from providers.json (user-added via Settings UI)
    store = config_service.get_providers_store()
    for entry in store.get("providers", []):
        name = entry.get("name", "")
        if not name or any(p["id"] == name for p in providers):
            continue
        api_key = entry.get("apiKey", "")
        if api_key:
            providers.append({
                "id": name,
                "name": name,
                "apiMode": entry.get("apiFormat", "openai-chat"),
                "isAvailable": True,
                "redactedKey": secrets.mask(api_key),
            })

    return {"activeProvider": active, "providers": providers}


@router.get("/safe")
async def config_safe():
    """Get full config (safe endpoint — returns everything the UI needs).

    Used by the frontend to read the active provider and its model settings.
    Returns the full config dict from config.json.
    """
    from app.lib.paths import data_path
    import json

    cfg_path = data_path("config.json")
    cfg = json.loads(cfg_path.read_text("utf-8")) if cfg_path.exists() else {}
    return cfg


# ── Model aliases (frontend: getUserModelAliases) ────────────────────


@router.get("/model-aliases")
async def get_model_aliases():
    """Return all model-alias entries for the UI's Aliases tab."""
    from app.services import alias_service
    return {"aliases": alias_service.list_aliases()}


class ModelAliasesBulk(BaseModel):
    aliases: list[dict[str, Any]]


@router.put("/model-aliases")
async def put_model_aliases(body: ModelAliasesBulk):
    """Replace the entire alias list (validated)."""
    from app.services import alias_service
    try:
        return {"aliases": alias_service.replace_aliases(body.aliases, actor="ui")}
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(400, detail={"code": "validation", "message": str(exc)})


# ── Sub-agent fallback (frontend: getSubAgentFallback) ───────────────


@router.get("/subagent-fallback")
async def get_subagent_fallback():
    """Return the current sub-agent fallback configuration."""
    from app.services import fallback_service
    return fallback_service.get_fallback()


class FallbackUpdate(BaseModel):
    enabled: bool | None = None
    mode: str | None = None
    provider: str | None = None
    model: str | None = None


@router.put("/subagent-fallback")
async def put_subagent_fallback(body: FallbackUpdate):
    """Update sub-agent fallback fields (partial)."""
    from app.services import fallback_service
    try:
        return fallback_service.configure_fallback(
            enabled=body.enabled,
            mode=body.mode,
            provider=body.provider,
            model=body.model,
            actor="ui",
        )
    except ValueError as exc:
        from fastapi import HTTPException
        raise HTTPException(400, detail={"code": "validation", "message": str(exc)})


class FallbackTest(BaseModel):
    model: str


@router.post("/subagent-fallback/test")
async def test_subagent_fallback(body: FallbackTest):
    """Probe resolution of a model id without saving."""
    from app.services import fallback_service
    return fallback_service.test_fallback(body.model)


class BackgroundReviewUpdate(BaseModel):
    enabled: bool | None = None
    reviewModel: str | None = None
    reflectionModel: str | None = None
    autoMemoryModel: str | None = None


@router.get("/background-review")
async def get_background_review():
    """Return the current background review config."""
    from app.services import background_review_service

    return background_review_service.get_config()


@router.put("/background-review")
async def put_background_review(body: BackgroundReviewUpdate):
    """Update background review config fields (partial)."""
    from app.services import background_review_service

    return background_review_service.save_config(
        enabled=body.enabled,
        review_model=body.reviewModel,
        reflection_model=body.reflectionModel,
        auto_memory_model=body.autoMemoryModel,
    )
