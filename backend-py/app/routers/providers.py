"""
Provider configuration management API routes.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.providers import registry, resolver
from app.lib import secrets
from app.services import config_service

router = APIRouter(prefix="/api/providers")


class ProviderCreate(BaseModel):
    name: str
    base_url: str
    api_format: str = "openai-chat"
    api_key: str = ""
    enabled: bool = True


@router.get("")
async def list_providers():
    """List all configured providers."""
    store = config_service.get_providers_store()
    raw = store.get("providers", [])
    result = []
    for p in raw:
        result.append({
            "id": p.get("id", ""),
            "name": p.get("name", ""),
            "baseUrl": p.get("baseUrl", ""),
            "apiFormat": p.get("apiFormat", ""),
            "enabled": p.get("enabled", False),
            "apiKeySet": bool(p.get("apiKey")),
            "autoFetch": p.get("autoFetch", False),
            "models": p.get("models", []),
        })
    return result


@router.post("")
async def create_provider(body: ProviderCreate):
    """Add a new provider."""
    import hashlib, time

    store = config_service.get_providers_store()
    if "providers" not in store:
        store["providers"] = []

    slug = body.name.lower().replace(" ", "-")[:40]
    rand = hashlib.md5(str(time.time()).encode()).hexdigest()[:6]
    provider_id = f"{slug}-{rand}"

    entry = {
        "id": provider_id,
        "name": body.name,
        "baseUrl": body.base_url,
        "apiFormat": body.api_format,
        "apiKey": body.api_key,
        "enabled": body.enabled,
        "autoFetch": False,
        "models": [],
    }
    store["providers"].append(entry)
    config_service.save_providers_store(store)
    return {**entry, "apiKeySet": bool(body.api_key)}


@router.get("/health")
async def providers_health():
    """Health check endpoint for providers."""
    return {"status": "ok"}
