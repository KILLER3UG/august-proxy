"""
Configuration API routes.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.providers import resolver as provider_resolver
from app.lib import secrets
from app.services import config_service

router = APIRouter(prefix="/api/config")


@router.get("/activeProvider")
async def active_provider():
    """Get active provider and list all available providers.

    Includes both built-in provider configs AND custom providers
    from providers.json so the frontend can show their models.
    """
    cfg = config_service.get_config()
    active = cfg.get("activeProvider")

    providers = []

    # Built-in providers
    for p in provider_resolver.list_available():
        api_key = cfg.get(p["name"], {}).get("apiKey", "")
        has_key = bool(api_key)
        providers.append({
            "id": p["name"],
            "name": p["name"],
            "apiMode": p.get("api_mode", ""),
            "isAvailable": has_key,
            "redactedKey": secrets.mask(api_key),
        })

    # Custom providers from providers.json (e.g., user-added via Settings UI)
    store = config_service.get_providers_store()
    for entry in store.get("providers", []):
        name = entry.get("name", "")
        if not name or any(p["id"] == name for p in providers):
            continue  # skip duplicates
        providers.append({
            "id": name,
            "name": name,
            "apiMode": entry.get("apiFormat", "openai-chat"),
            "isAvailable": bool(entry.get("apiKey")),
            "redactedKey": secrets.mask(entry.get("apiKey", "")),
        })

    return {"activeProvider": active, "providers": providers}
