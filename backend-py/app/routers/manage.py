"""
Management endpoints — /api/manage/*

Resources that don't fit existing routers: aliases, settings, snapshot.
Replaces the legacy /ui/august/* action-dispatch pattern.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.providers import resolver as provider_resolver
from app.services.memory_store import get_stats
from app.services.workbench.workbench import list_workbench_sessions

router = APIRouter(prefix="/api/manage")


# ── Models ───────────────────────────────────────────────────────────


class AliasCreate(BaseModel):
    alias: str
    target_model: str
    target_provider: str = ""


class AliasUpdate(BaseModel):
    target_model: str | None = None
    target_provider: str | None = None


class SettingsUpdate(BaseModel):
    updates: dict[str, Any]


# ── Helpers ─────────────────────────────────────────────────────────


def _read_aliases() -> list[dict[str, Any]]:
    from app.lib.paths import data_path
    p = data_path("config.json")
    if not p.exists():
        return []
    cfg = json.loads(p.read_text("utf-8"))
    return cfg.get("modelAliases", [])


def _write_aliases(aliases: list[dict[str, Any]]) -> None:
    from app.lib.paths import data_path
    p = data_path("config.json")
    cfg = json.loads(p.read_text("utf-8")) if p.exists() else {}
    cfg["modelAliases"] = aliases
    p.write_text(json.dumps(cfg, indent=2), "utf-8")
    settings.reload()


def _err(code: str, message: str, status: int = 404) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


# ═══════════════════════════════════════════════════════════════════════
#  Snapshot
# ═══════════════════════════════════════════════════════════════════════


@router.get("/snapshot")
async def snapshot():
    """Full state snapshot for the UI's initial page load."""
    providers = provider_resolver.list_available()
    return {
        "providers": [
            {
                "id": p.get("name", ""),
                "name": p.get("name", ""),
                "description": p.get("description", ""),
                "baseUrl": p.get("base_url", ""),
                "apiFormat": p.get("api_mode", ""),
                "defaultModel": p.get("default_model", ""),
                "enabled": True,
                "models": list(p.get("model_profiles", {}).keys()),
            }
            for p in providers
        ],
        "sessions": list_workbench_sessions(),
        "memory": get_stats(),
    }


# ═══════════════════════════════════════════════════════════════════════
#  Aliases
# ═══════════════════════════════════════════════════════════════════════


@router.get("/aliases")
async def list_aliases():
    """List all model aliases."""
    return _read_aliases()


@router.post("/aliases")
async def create_alias(body: AliasCreate):
    """Create or update a model alias."""
    aliases = _read_aliases()
    entry = {
        "alias": body.alias,
        "targetModel": body.target_model,
        "targetProvider": body.target_provider,
    }
    existing = next((a for a in aliases if a.get("alias") == body.alias), None)
    if existing:
        existing.update(entry)
    else:
        aliases.append(entry)
    _write_aliases(aliases)
    return entry


@router.put("/aliases/{alias_name}")
async def update_alias(alias_name: str, body: AliasUpdate):
    """Update a model alias."""
    aliases = _read_aliases()
    existing = next((a for a in aliases if a.get("alias") == alias_name), None)
    if not existing:
        raise _err("not_found", "Alias not found")
    if body.target_model is not None:
        existing["targetModel"] = body.target_model
    if body.target_provider is not None:
        existing["targetProvider"] = body.target_provider
    _write_aliases(aliases)
    return existing


@router.delete("/aliases/{alias_name}")
async def delete_alias(alias_name: str):
    """Delete a model alias."""
    aliases = _read_aliases()
    before = len(aliases)
    aliases = [a for a in aliases if a.get("alias") != alias_name]
    if len(aliases) == before:
        raise _err("not_found", "Alias not found")
    _write_aliases(aliases)
    return {"deleted": True}


# ═══════════════════════════════════════════════════════════════════════
#  Settings
# ═══════════════════════════════════════════════════════════════════════


@router.put("/settings")
async def update_settings(body: SettingsUpdate):
    """Bulk-update application settings (deep merge into config.json)."""
    from app.lib.paths import data_path

    p = data_path("config.json")
    cfg = json.loads(p.read_text("utf-8")) if p.exists() else {}

    def deep_set(target: dict, keys: list[str], value: Any) -> None:
        for key in keys[:-1]:
            target = target.setdefault(key, {})
        target[keys[-1]] = value

    for key_path, value in body.updates.items():
        deep_set(cfg, key_path.split("."), value)

    p.write_text(json.dumps(cfg, indent=2), "utf-8")
    settings.reload()
    return {"updated": list(body.updates.keys())}
