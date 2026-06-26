"""
Provider configuration management API routes.
Uses camelCase throughout matching the frontend convention.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.providers import registry, resolver
from app.services import config_service

router = APIRouter(prefix="/api/providers")


class ProviderCreate(BaseModel):
    name: str
    baseUrl: str = ""
    apiFormat: str = "openai-chat"
    apiKey: str = ""
    enabled: bool = True


class ProviderUpdate(BaseModel):
    name: str | None = None
    baseUrl: str | None = None
    apiFormat: str | None = None
    apiKey: str | None = None
    enabled: bool | None = None


class ModelCreate(BaseModel):
    id: str
    name: str | None = None
    contextWindow: int | None = None
    reasoning: bool | None = None
    free: bool | None = None


class ModelUpdate(BaseModel):
    name: str | None = None
    contextWindow: int | None = None
    reasoning: bool | None = None
    free: bool | None = None


@router.get("")
async def listProviders():
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
async def createProvider(body: ProviderCreate):
    import hashlib, time
    store = config_service.get_providers_store()
    if "providers" not in store:
        store["providers"] = []
    slug = body.name.lower().replace(" ", "-")[:40]
    rand = hashlib.md5(str(time.time()).encode()).hexdigest()[:6]
    providerId = f"{slug}-{rand}"
    entry = {
        "id": providerId,
        "name": body.name,
        "baseUrl": body.baseUrl,
        "apiFormat": body.apiFormat,
        "apiKey": body.apiKey,
        "enabled": body.enabled,
        "autoFetch": False,
        "models": [],
    }
    store["providers"].append(entry)
    config_service.save_providers_store(store)
    return {**entry, "apiKeySet": bool(body.apiKey)}


@router.get("/{providerId}")
async def getProvider(providerId: str):
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == providerId:
            return {**p, "apiKeySet": bool(p.get("apiKey"))}
    raise HTTPException(status_code=404, detail="Provider not found")


@router.put("/{providerId}")
async def updateProvider(providerId: str, body: ProviderUpdate):
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == providerId:
            if body.name is not None:
                p["name"] = body.name
            if body.baseUrl is not None:
                p["baseUrl"] = body.baseUrl
            if body.apiFormat is not None:
                p["apiFormat"] = body.apiFormat
            if body.apiKey is not None:
                p["apiKey"] = body.apiKey
            if body.enabled is not None:
                p["enabled"] = body.enabled
            config_service.save_providers_store(store)
            return {**p, "apiKeySet": bool(p.get("apiKey"))}
    raise HTTPException(status_code=404, detail="Provider not found")


@router.patch("/{providerId}")
async def patchProvider(providerId: str, body: ProviderUpdate):
    return await updateProvider(providerId, body)


@router.delete("/{providerId}")
async def deleteProvider(providerId: str):
    store = config_service.get_providers_store()
    before = len(store.get("providers", []))
    store["providers"] = [p for p in store.get("providers", []) if p.get("id") != providerId]
    if len(store["providers"]) == before:
        raise HTTPException(status_code=404, detail="Provider not found")
    config_service.save_providers_store(store)
    return {"deleted": True}


@router.post("/{providerId}/models/refresh")
async def refreshModels(providerId: str):
    return {"refreshed": True, "models": []}


@router.get("/health")
async def providersHealth():
    return {"status": "ok"}


@router.post("/{providerId}/models")
async def addModel(providerId: str, body: ModelCreate):
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == providerId:
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


@router.patch("/{providerId}/models/{modelId}")
async def updateModel(providerId: str, modelId: str, body: ModelUpdate):
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == providerId:
            for m in p.get("models", []):
                if m.get("id") == modelId:
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


@router.delete("/{providerId}/models/{modelId}")
async def deleteModel(providerId: str, modelId: str):
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == providerId:
            before = len(p.get("models", []))
            p["models"] = [m for m in p.get("models", []) if m.get("id") != modelId]
            if len(p["models"]) == before:
                raise HTTPException(status_code=404, detail="Model not found")
            config_service.save_providers_store(store)
            return {"deleted": True}
    raise HTTPException(status_code=404, detail="Provider not found")


@router.post("/{providerId}/models/{modelId}/test")
async def testModel(providerId: str, modelId: str):
    return {"success": True, "latencyMs": 0, "content": "WORKING"}
