"""
UI August routes — /ui/august/* self-management API.

Port of backend/services/august-api/august-api-routes.js + august-api.js.

Used by the frontend for managing providers, sessions, agents,
memory, aliases, tools, and rollbacks.
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import settings
from app.services import config_service
from app.services.memory_store import (
    save_memory, get_memory, delete_memory,
    save_fact, get_fact, search_facts, delete_fact,
    record_lifecycle, get_stats,
)
from app.services.workbench.workbench import (
    create_workbench_session, list_workbench_sessions,
    get_workbench_session, delete_workbench_session,
)

router = APIRouter(prefix="/ui/august")


# ── Models ────────────────────────────────────────────────────────────

class SessionsManage(BaseModel):
    action: str
    id: str | None = None
    title: str | None = None
    updates: dict[str, Any] | None = None
    provider: str | None = None
    agentId: str | None = None
    guardMode: str | None = None


class SettingsUpdate(BaseModel):
    key_path: str
    value: Any


class ModelSelect(BaseModel):
    model: str
    provider: str = ""


class ProviderManage(BaseModel):
    action: str
    provider: dict[str, Any] | None = None
    id: str | None = None


class AgentManage(BaseModel):
    action: str
    agent: dict[str, Any] | None = None
    id: str | None = None


class MemoryManage(BaseModel):
    action: str
    key: str = ""
    value: Any = None
    category: str = "general"
    ttl_days: int = 0


class AliasManage(BaseModel):
    action: str
    alias: dict[str, Any] | None = None
    id: str | None = None


class ToolManage(BaseModel):
    action: str
    tool: dict[str, Any] | None = None
    id: str | None = None


# ── Snapshot ─────────────────────────────────────────────────────────


@router.get("/snapshot")
async def build_snapshot():
    """Build a full snapshot of the current state."""
    from app.providers import resolver

    providers = resolver.list_available()
    return {
        "ok": True,
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


# ── Sessions ─────────────────────────────────────────────────────────


@router.post("/sessions/manage")
async def manage_sessions(body: SessionsManage):
    """Manage workbench sessions (list/create/update/rename/archive/delete)."""
    action = body.action

    if action == "list":
        return {"ok": True, "sessions": list_workbench_sessions()}

    if action == "create":
        session = create_workbench_session(
            provider=body.provider or "",
            agent_id=body.agentId or "",
            guard_mode=body.guardMode or "",
        )
        return {"ok": True, "session": session.to_dict()}

    if action == "update":
        session = get_workbench_session(body.id or "")
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if body.updates:
            for k, v in body.updates.items():
                if hasattr(session, k):
                    setattr(session, k, v)
        return {"ok": True, "session": session.to_dict()}

    if action == "rename":
        session = get_workbench_session(body.id or "")
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if body.title:
            session.title = body.title
        return {"ok": True, "session": session.to_dict()}

    if action == "delete":
        deleted = delete_workbench_session(body.id or "")
        return {"ok": deleted, "deleted": deleted}

    raise HTTPException(status_code=400, detail=f"Unknown sessions action: {action}")


# ── Settings ─────────────────────────────────────────────────────────


@router.post("/settings/update")
async def update_setting(body: SettingsUpdate):
    """Update a config setting by key path."""
    try:
        from app.lib.paths import data_path
        import json

        cfg_path = data_path("config.json")
        cfg = json.loads(cfg_path.read_text("utf-8")) if cfg_path.exists() else {}

        # Navigate key path (e.g., "gemini.apiKey")
        keys = body.key_path.split(".")
        target = cfg
        for key in keys[:-1]:
            target = target.setdefault(key, {})
        target[keys[-1]] = body.value

        cfg_path.write_text(json.dumps(cfg, indent=2), "utf-8")
        settings.reload()
        return {"ok": True}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))


# ── Model selection ──────────────────────────────────────────────────


@router.post("/models/select")
async def select_model(body: ModelSelect):
    """Set the active model."""
    from app.services.config_service import set_active_provider

    set_active_provider(body.provider)
    return {"ok": True, "model": body.model, "provider": body.provider}


# ── Providers ────────────────────────────────────────────────────────


@router.post("/providers/manage")
async def manage_providers(body: ProviderManage):
    """Upsert or delete a provider."""
    action = body.action

    if action == "upsert":
        provider = body.provider
        if not provider or (not provider.get("id") and not provider.get("name")):
            raise HTTPException(status_code=400, detail="provider.id or provider.name is required")

        # Store to the JSON-based providers store
        store = config_service.get_providers_store()
        if "providers" not in store:
            store["providers"] = []

        existing = None
        for p in store["providers"]:
            if p.get("id") == provider.get("id") or p.get("name") == provider.get("name"):
                existing = p
                break

        if existing:
            existing.update(provider)
        else:
            if not provider.get("id"):
                provider["id"] = f"prov_{uuid.uuid4().hex[:8]}"
            store["providers"].append(provider)

        config_service.save_providers_store(store)
        return {"ok": True, "provider": provider}

    if action == "delete":
        pid = body.id or (body.provider or {}).get("id", "")
        if not pid:
            raise HTTPException(status_code=400, detail="provider id is required")

        store = config_service.get_providers_store()
        store["providers"] = [p for p in store.get("providers", []) if p.get("id") != pid and p.get("name") != pid]
        config_service.save_providers_store(store)
        return {"ok": True, "deleted": True}

    raise HTTPException(status_code=400, detail=f"Unknown providers action: {action}")


# ── Agents ───────────────────────────────────────────────────────────


@router.post("/agents/manage")
async def manage_agents(body: AgentManage):
    """Upsert or delete an agent."""
    from app.services.tools.agent_registry import create_agent, delete_agent, get_agent, list_agents

    action = body.action

    if action == "list":
        return {"ok": True, "agents": list_agents()}

    if action == "upsert":
        agent = body.agent
        if not agent or not agent.get("name"):
            raise HTTPException(status_code=400, detail="agent.name is required")
        created = create_agent(
            name=agent["name"],
            parent_id=agent.get("parentId", ""),
            permissions=agent.get("permissions", []),
            toolsets=agent.get("toolsets", []),
            model=agent.get("model", ""),
            provider=agent.get("provider", ""),
        )
        return {"ok": True, "agent": created}

    if action == "delete":
        aid = body.id or (body.agent or {}).get("id", "")
        if not aid:
            raise HTTPException(status_code=400, detail="agent id is required")
        deleted = delete_agent(aid)
        return {"ok": deleted, "deleted": deleted}

    raise HTTPException(status_code=400, detail=f"Unknown agents action: {action}")


# ── Memory ───────────────────────────────────────────────────────────


@router.post("/memory/manage")
async def manage_memory(body: MemoryManage):
    """Manage memory facts (upsert/delete)."""
    action = body.action

    if action in ("upsert", "set"):
        save_fact(body.key, body.value, category=body.category)
        return {"ok": True}

    if action in ("delete", "forget"):
        deleted = delete_fact(body.key)
        return {"ok": deleted, "deleted": deleted}

    raise HTTPException(status_code=400, detail=f"Unknown memory action: {action}")


# ── Aliases ──────────────────────────────────────────────────────────


@router.post("/aliases/manage")
async def manage_aliases(body: AliasManage):
    """Manage model aliases."""
    import json
    from app.lib.paths import data_path

    action = body.action
    cfg_path = data_path("config.json")
    cfg = json.loads(cfg_path.read_text("utf-8")) if cfg_path.exists() else {}
    aliases = cfg.get("modelAliases", [])

    if action == "list":
        return {"ok": True, "aliases": aliases}

    if action == "upsert":
        alias = body.alias
        if not alias or not alias.get("alias"):
            raise HTTPException(status_code=400, detail="alias.alias is required")
        existing = next((a for a in aliases if a.get("alias") == alias["alias"]), None)
        if existing:
            existing.update(alias)
        else:
            aliases.append(alias)
        cfg["modelAliases"] = aliases
        cfg_path.write_text(json.dumps(cfg, indent=2), "utf-8")
        settings.reload()
        return {"ok": True, "alias": alias}

    if action == "delete":
        alias_id = body.id or (body.alias or {}).get("alias", "")
        cfg["modelAliases"] = [a for a in aliases if a.get("alias") != alias_id]
        cfg_path.write_text(json.dumps(cfg, indent=2), "utf-8")
        settings.reload()
        return {"ok": True, "deleted": True}

    raise HTTPException(status_code=400, detail=f"Unknown aliases action: {action}")


# ── Tools ────────────────────────────────────────────────────────────


@router.post("/tools/manage")
async def manage_tools(body: ToolManage):
    """Manage custom tools."""
    from app.services.tool_registry import list_tools

    action = body.action

    if action == "list":
        return {"ok": True, "tools": list_tools()}

    raise HTTPException(status_code=400, detail=f"Unknown tools action: {action}")
