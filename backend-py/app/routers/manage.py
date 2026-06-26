"""
Management API — /api/manage/*

Modern RESTful API (2026) for the frontend Settings UI.
Replaces the legacy /ui/august/* action-dispatch pattern.

Standard response envelope:
    { "data": T, "error": null | { "code": str, "message": str }, "meta": { "total": int } }
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.services import config_service
from app.services.memory_store import (
    save_fact, get_fact, search_facts, delete_fact,
    get_stats,
)
from app.services.tools.agent_registry import create_agent, delete_agent, list_agents, get_agent
from app.services.workbench.workbench import (
    create_workbench_session, get_workbench_session,
    delete_workbench_session, list_workbench_sessions,
)
from app.providers import resolver as provider_resolver

router = APIRouter(prefix="/api/manage")


# ── Response helpers ─────────────────────────────────────────────────


def ok(data: Any, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    resp: dict[str, Any] = {"data": data, "error": None}
    if meta:
        resp["meta"] = meta
    return resp


def err(code: str, message: str, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


# ── Models ───────────────────────────────────────────────────────────


class SessionCreate(BaseModel):
    provider: str = ""
    agent_id: str = ""
    guard_mode: str = ""
    title: str = "New Session"


class SessionUpdate(BaseModel):
    title: str | None = None
    provider: str | None = None
    is_archived: bool | None = None


class ProviderCreate(BaseModel):
    name: str
    base_url: str
    api_format: str = "openai-chat"
    api_key: str = ""
    enabled: bool = True


class ProviderUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_format: str | None = None
    api_key: str | None = None
    enabled: bool | None = None


class AgentCreate(BaseModel):
    name: str
    parent_id: str = ""
    permissions: list[str] = []
    toolsets: list[str] = []
    model: str = ""
    provider: str = ""


class AgentUpdate(BaseModel):
    name: str | None = None
    permissions: list[str] | None = None
    toolsets: list[str] | None = None
    model: str | None = None
    provider: str | None = None


class AliasCreate(BaseModel):
    alias: str
    target_model: str
    target_provider: str = ""


class AliasUpdate(BaseModel):
    target_model: str | None = None
    target_provider: str | None = None


class FactCreate(BaseModel):
    key: str
    value: Any
    category: str = "general"


class SettingsUpdate(BaseModel):
    updates: dict[str, Any]


# ═══════════════════════════════════════════════════════════════════════
#  Snapshot
# ═══════════════════════════════════════════════════════════════════════


@router.get("/snapshot")
async def snapshot():
    """Full state snapshot for initial page load."""
    providers = provider_resolver.list_available()
    return ok({
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
    })


# ═══════════════════════════════════════════════════════════════════════
#  Sessions
# ═══════════════════════════════════════════════════════════════════════


@router.get("/sessions")
async def list_sessions():
    """List all workbench sessions."""
    return ok(list_workbench_sessions())


@router.post("/sessions")
async def create_session(body: SessionCreate):
    """Create a new workbench session."""
    session = create_workbench_session(
        provider=body.provider,
        agent_id=body.agent_id,
        guard_mode=body.guard_mode,
    )
    return ok(session.to_dict())


@router.get("/sessions/{session_id}")
async def get_session_route(session_id: str):
    """Get a session by ID."""
    session = get_workbench_session(session_id)
    if not session:
        raise err("not_found", "Session not found", 404)
    return ok(session.to_dict())


@router.patch("/sessions/{session_id}")
async def update_session(session_id: str, body: SessionUpdate):
    """Update a session (rename, archive, change provider)."""
    session = get_workbench_session(session_id)
    if not session:
        raise err("not_found", "Session not found", 404)
    if body.title is not None:
        session.title = body.title
    if body.provider is not None:
        session.provider = body.provider
    if body.is_archived is not None:
        session.metadata["isArchived"] = body.is_archived
    return ok(session.to_dict())


@router.delete("/sessions/{session_id}")
async def delete_session_route(session_id: str):
    """Delete a session."""
    if not delete_workbench_session(session_id):
        raise err("not_found", "Session not found", 404)
    return ok({"deleted": True})


# ═══════════════════════════════════════════════════════════════════════
#  Providers
# ═══════════════════════════════════════════════════════════════════════


@router.get("/providers")
async def list_providers():
    """List all configured providers."""
    store = config_service.get_providers_store()
    return ok(store.get("providers", []))


@router.post("/providers")
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
    return ok({**entry, "apiKeySet": bool(body.api_key)})


@router.get("/providers/{provider_id}")
async def get_provider(provider_id: str):
    """Get a provider by ID."""
    store = config_service.get_providers_store()
    for p in store.get("providers", []):
        if p.get("id") == provider_id:
            return ok(p)
    raise err("not_found", "Provider not found", 404)


@router.put("/providers/{provider_id}")
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
            return ok(p)
    raise err("not_found", "Provider not found", 404)


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str):
    """Delete a provider."""
    store = config_service.get_providers_store()
    before = len(store.get("providers", []))
    store["providers"] = [p for p in store.get("providers", []) if p.get("id") != provider_id]
    if len(store["providers"]) == before:
        raise err("not_found", "Provider not found", 404)
    config_service.save_providers_store(store)
    return ok({"deleted": True})


# ═══════════════════════════════════════════════════════════════════════
#  Agents
# ═══════════════════════════════════════════════════════════════════════


@router.get("/agents")
async def list_agents_route():
    """List all agents."""
    return ok(list_agents())


@router.post("/agents")
async def create_agent_route(body: AgentCreate):
    """Create a new agent."""
    agent = create_agent(
        name=body.name,
        parent_id=body.parent_id,
        permissions=body.permissions,
        toolsets=body.toolsets,
        model=body.model,
        provider=body.provider,
    )
    return ok(agent)


@router.get("/agents/{agent_id}")
async def get_agent_route(agent_id: str):
    """Get an agent by ID."""
    agent = get_agent(agent_id)
    if not agent:
        raise err("not_found", "Agent not found", 404)
    return ok(agent)


@router.delete("/agents/{agent_id}")
async def delete_agent_route(agent_id: str):
    """Delete an agent."""
    if not delete_agent(agent_id):
        raise err("not_found", "Agent not found", 404)
    return ok({"deleted": True})


# ═══════════════════════════════════════════════════════════════════════
#  Aliases
# ═══════════════════════════════════════════════════════════════════════


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


@router.get("/aliases")
async def list_aliases_route():
    """List all model aliases."""
    return ok(_read_aliases())


@router.post("/aliases")
async def create_alias(body: AliasCreate):
    """Create a model alias."""
    aliases = _read_aliases()
    entry = {
        "alias": body.alias,
        "targetModel": body.target_model,
        "targetProvider": body.target_provider,
    }
    # Upsert
    existing = next((a for a in aliases if a.get("alias") == body.alias), None)
    if existing:
        existing.update(entry)
    else:
        aliases.append(entry)
    _write_aliases(aliases)
    return ok(entry)


@router.put("/aliases/{alias_name}")
async def update_alias(alias_name: str, body: AliasUpdate):
    """Update a model alias."""
    aliases = _read_aliases()
    existing = next((a for a in aliases if a.get("alias") == alias_name), None)
    if not existing:
        raise err("not_found", "Alias not found", 404)
    if body.target_model is not None:
        existing["targetModel"] = body.target_model
    if body.target_provider is not None:
        existing["targetProvider"] = body.target_provider
    _write_aliases(aliases)
    return ok(existing)


@router.delete("/aliases/{alias_name}")
async def delete_alias(alias_name: str):
    """Delete a model alias."""
    aliases = _read_aliases()
    before = len(aliases)
    aliases = [a for a in aliases if a.get("alias") != alias_name]
    if len(aliases) == before:
        raise err("not_found", "Alias not found", 404)
    _write_aliases(aliases)
    return ok({"deleted": True})


# ═══════════════════════════════════════════════════════════════════════
#  Memory / Facts
# ═══════════════════════════════════════════════════════════════════════


@router.get("/memory")
async def list_facts_route(category: str = ""):
    """List memory facts."""
    return ok(search_facts("", category) if category else list_facts_all())


def list_facts_all() -> list[dict[str, Any]]:
    from app.services.memory_store import list_facts
    return list_facts()


@router.post("/memory")
async def create_fact(body: FactCreate):
    """Save a memory fact."""
    save_fact(body.key, body.value, category=body.category)
    return ok({"key": body.key, "saved": True})


@router.delete("/memory/{fact_key}")
async def delete_fact_route(fact_key: str):
    """Delete a memory fact."""
    if not delete_fact(fact_key):
        raise err("not_found", "Fact not found", 404)
    return ok({"deleted": True})


# ═══════════════════════════════════════════════════════════════════════
#  Settings
# ═══════════════════════════════════════════════════════════════════════


@router.put("/settings")
async def update_settings(body: SettingsUpdate):
    """Bulk-update application settings."""
    from app.lib.paths import data_path

    p = data_path("config.json")
    cfg = json.loads(p.read_text("utf-8")) if p.exists() else {}

    # Deep merge
    def deep_set(target: dict, keys: list[str], value: Any) -> None:
        for key in keys[:-1]:
            target = target.setdefault(key, {})
        target[keys[-1]] = value

    for key_path, value in body.updates.items():
        deep_set(cfg, key_path.split("."), value)

    p.write_text(json.dumps(cfg, indent=2), "utf-8")
    settings.reload()
    return ok({"updated": list(body.updates.keys())})
