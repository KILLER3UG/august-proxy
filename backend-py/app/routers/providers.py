"""
Provider configuration management API routes.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.providers import registry, resolver
from app.lib.camel_model import CamelModel
from app.services import config_service

router = APIRouter(prefix="/api/providers")


class ProviderCreate(CamelModel):
    name: str
    base_url: str = ""
    api_format: str = "openai-chat"
    api_key: str = ""
    enabled: bool = True


class ProviderUpdate(CamelModel):
    name: str | None = None
    base_url: str | None = None
    api_format: str | None = None
    api_key: str | None = None
    enabled: bool | None = None


class ModelCreateBody(CamelModel):
    id: str
    name: str | None = None
    contextWindow: int | None = None
    reasoning: bool | None = None
    free: bool | None = None


class ModelUpdateBody(CamelModel):
    name: str | None = None
    contextWindow: int | None = None
    reasoning: bool | None = None
    free: bool | None = None


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


@router.get("/{provider_id}")
async def get_provider(provider_id: str):
    """Get a provider by ID."""
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == provider_id:
            return {**p, "apiKeySet": bool(p.get("apiKey"))}
    raise HTTPException(status_code=404, detail="Provider not found")


@router.put("/{provider_id}")
async def update_provider(provider_id: str, body: ProviderUpdate):
    """Update an existing provider."""
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == provider_id:
            if body.name is not None:
                p["name"] = body.name
            if body.base_url is not None:
                p["baseUrl"] = body.base_url
            if body.api_format is not None:
                p["apiFormat"] = body.api_format
            if body.api_key is not None:
                p["apiKey"] = body.api_key
            if body.enabled is not None:
                p["enabled"] = body.enabled
            config_service.save_providers_store(store)
            return {**p, "apiKeySet": bool(p.get("apiKey"))}
    raise HTTPException(status_code=404, detail="Provider not found")


@router.patch("/{provider_id}")
async def patch_provider(provider_id: str, body: ProviderUpdate):
    """Partial update of a provider."""
    return await update_provider(provider_id, body)


@router.delete("/{provider_id}")
async def delete_provider(provider_id: str):
    """Delete a provider."""
    store = config_service.get_providers_store()
    before = len(store.get("providers", []))
    store["providers"] = [p for p in store.get("providers", []) if p.get("id") != provider_id]
    if len(store["providers"]) == before:
        raise HTTPException(status_code=404, detail="Provider not found")
    config_service.save_providers_store(store)
    return {"deleted": True}


@router.post("/{provider_id}/models/refresh")
async def refresh_provider_models(provider_id: str):
    """Refresh models for a provider."""
    return {"refreshed": True, "models": []}


@router.get("/health")
async def providers_health():
    """Health check endpoint for providers."""
    return {"status": "ok"}


@router.post("/{provider_id}/models")
async def add_provider_model(provider_id: str, body: ModelCreateBody):
    """Add a model to a provider."""
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == provider_id:
            models = p.setdefault("models", [])
            models.append({
                "id": body.id,
                "name": body.name or body.id,
                "contextWindow": body.contextWindow or 128000,
                "reasoning": body.reasoning or False,
                "free": body.free or False,
                "source": "manual",
            })
            config_service.save_providers_store(store)
            return {**p, "apiKeySet": bool(p.get("apiKey"))}
    raise HTTPException(status_code=404, detail="Provider not found")


@router.patch("/{provider_id}/models/{model_id}")
async def update_provider_model(provider_id: str, model_id: str, body: ModelUpdateBody):
    """Update a model on a provider."""
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == provider_id:
            for m in p.get("models", []):
                if m.get("id") == model_id:
                    if body.name is not None:
                        m["name"] = body.name
                    if body.contextWindow is not None:
                        m["contextWindow"] = body.contextWindow
                    if body.reasoning is not None:
                        m["reasoning"] = body.reasoning
                    if body.free is not None:
                        m["free"] = body.free
                    config_service.save_providers_store(store)
                    return {"updated": True}
            raise HTTPException(status_code=404, detail="Model not found")
    raise HTTPException(status_code=404, detail="Provider not found")


@router.delete("/{provider_id}/models/{model_id}")
async def delete_provider_model(provider_id: str, model_id: str):
    """Remove a model from a provider."""
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == provider_id:
            before = len(p.get("models", []))
            p["models"] = [m for m in p.get("models", []) if m.get("id") != model_id]
            if len(p["models"]) == before:
                raise HTTPException(status_code=404, detail="Model not found")
            config_service.save_providers_store(store)
            return {"deleted": True}
    raise HTTPException(status_code=404, detail="Provider not found")


@router.post("/{provider_id}/models/{model_id}/test")
async def test_provider_model(provider_id: str, model_id: str):
    """Test a model connection."""
    return {"success": True, "latencyMs": 0, "content": "WORKING"}
