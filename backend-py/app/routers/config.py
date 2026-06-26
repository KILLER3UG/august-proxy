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
