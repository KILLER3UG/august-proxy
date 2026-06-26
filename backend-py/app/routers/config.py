"""
Configuration API routes.
"""

from __future__ import annotations

from fastapi import APIRouter
from app.lib.camel_model import CamelModel

from app.providers import resolver as provider_resolver
from app.lib import secrets
from app.services import config_service

router = APIRouter(prefix="/api/config")


@router.get("/activeProvider")
async def active_provider():
    """Get active provider and list all available providers."""
    cfg = config_service.get_config()
    active = cfg.get("activeProvider")

    providers = []
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

    return {"activeProvider": active, "providers": providers}
