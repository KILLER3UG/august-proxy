"""
Alias service — single source of truth for model-alias CRUD.

Shared by the agent-callable alias tools and the HTTP routes (``/api/manage``
and ``/api/config/model-aliases``). Centralises read/write of the
``config.json`` ``modelAliases`` list, adds provider+model validation, reloads
settings so resolvers see changes immediately, invalidates the model cache so
the dropdown refreshes, and records every change to the config audit log.
"""

from __future__ import annotations

from typing import Any

from app.config import settings
from app.lib.paths import data_path
from app.services.memory_store import record_config_audit


# ── Read / write ─────────────────────────────────────────────────────


def list_aliases() -> list[dict[str, Any]]:
    """Return all model-alias entries (full records, not just names)."""
    import json

    p = data_path("config.json")
    if not p.exists():
        return []
    try:
        cfg = json.loads(p.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    aliases = cfg.get("modelAliases", [])
    return aliases if isinstance(aliases, list) else []


def _write_aliases(aliases: list[dict[str, Any]]) -> None:
    import json

    p = data_path("config.json")
    cfg = json.loads(p.read_text("utf-8")) if p.exists() else {}
    cfg["modelAliases"] = aliases
    p.write_text(json.dumps(cfg, indent=2), "utf-8")
    settings.reload()
    # Drop the aggregated-model cache so the UI dropdown re-fetches.
    try:
        from app.services import model_service
        model_service.invalidate_cache()
    except Exception:
        pass


def _find(alias: str) -> dict[str, Any] | None:
    for a in list_aliases():
        if a.get("alias") == alias:
            return a
    return None


# ── Validation ───────────────────────────────────────────────────────


def _provider_names() -> set[str]:
    """All known provider names + aliases (built-in and custom)."""
    names: set[str] = set()
    try:
        from app.providers import registry, resolver as provider_resolver
        # Ensure built-ins are registered before listing.
        try:
            from app.providers import builtin
            builtin.register_all()
        except Exception:
            pass
        for p in registry.list_all():
            names.add(p.get("name", ""))
            for a in p.get("aliases", []) or []:
                names.add(a)
        for p in provider_resolver.list_available():
            names.add(p.get("name", ""))
    except Exception:
        pass
    # Custom providers from providers.json
    try:
        from app.services import config_service
        store = config_service.get_providers_store()
        for entry in store.get("providers", []):
            names.add(entry.get("name", ""))
    except Exception:
        pass
    names.discard("")
    return names


def validate_target(target_provider: str, target_model: str) -> tuple[bool, str]:
    """Validate that provider (strict) and model (loose) are plausible.

    Returns ``(ok, message)``. An unknown provider is a hard error; an
    unknown model is a soft warning (it may still be valid upstream).
    """
    if not target_provider:
        return False, "target_provider is required"
    if target_provider not in _provider_names():
        return False, f"Unknown provider '{target_provider}'"
    if not target_model:
        return False, "target_model is required"
    return True, ""


# ── CRUD ─────────────────────────────────────────────────────────────


def create_alias(
    alias: str,
    target_model: str,
    target_provider: str,
    actor: str = "system",
    display_alias: str = "",
) -> dict[str, Any]:
    """Create or upsert a model alias. Returns the stored entry."""
    alias = (alias or "").strip()
    if not alias:
        raise ValueError("alias is required")

    ok, msg = validate_target(target_provider, target_model)
    if not ok:
        raise ValueError(msg)

    aliases = list_aliases()
    entry: dict[str, Any] = {
        "alias": alias,
        "targetModel": target_model,
        "targetProvider": target_provider,
    }
    if display_alias:
        entry["displayAlias"] = display_alias

    before = _find(alias)
    if before is not None:
        before_copy = dict(before)
        before.update(entry)
        entry = before
    else:
        before_copy = None
        aliases.append(entry)

    _write_aliases(aliases)
    record_config_audit("alias", "create" if before_copy is None else "upsert", actor, before=before_copy, after=entry)
    return entry


def update_alias(
    alias: str,
    target_model: str | None = None,
    target_provider: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    """Update an existing alias. Raises if not found."""
    aliases = list_aliases()
    existing = next((a for a in aliases if a.get("alias") == alias), None)
    if existing is None:
        raise KeyError(f"Alias '{alias}' not found")

    before = dict(existing)
    new_model = target_model if target_model is not None else existing.get("targetModel", "")
    new_provider = target_provider if target_provider is not None else existing.get("targetProvider", "")
    ok, msg = validate_target(new_provider, new_model)
    if not ok:
        raise ValueError(msg)

    if target_model is not None:
        existing["targetModel"] = target_model
    if target_provider is not None:
        existing["targetProvider"] = target_provider

    _write_aliases(aliases)
    record_config_audit("alias", "update", actor, before=before, after=existing)
    return existing


def delete_alias(alias: str, actor: str = "system") -> bool:
    """Delete an alias. Returns True if removed."""
    aliases = list_aliases()
    before = next((a for a in aliases if a.get("alias") == alias), None)
    new_aliases = [a for a in aliases if a.get("alias") != alias]
    if len(new_aliases) == len(aliases):
        return False
    _write_aliases(new_aliases)
    record_config_audit("alias", "delete", actor, before=before, after=None)
    return True


def replace_aliases(aliases: list[dict[str, Any]], actor: str = "system") -> list[dict[str, Any]]:
    """Replace the entire alias list. Validates each entry's provider first."""
    normalised: list[dict[str, Any]] = []
    for entry in aliases:
        alias = (entry.get("alias") or "").strip()
        if not alias:
            raise ValueError("alias entry missing 'alias' field")
        target_model = entry.get("targetModel") or entry.get("target_model") or ""
        target_provider = entry.get("targetProvider") or entry.get("target_provider") or ""
        ok, msg = validate_target(target_provider, target_model)
        if not ok:
            raise ValueError(f"Alias '{alias}': {msg}")
        normalised.append({
            "alias": alias,
            "targetModel": target_model,
            "targetProvider": target_provider,
            **({"displayAlias": entry["displayAlias"]} if entry.get("displayAlias") else {}),
        })
    before = list_aliases()
    _write_aliases(normalised)
    record_config_audit("alias", "replace", actor, before=before, after=normalised)
    return normalised
