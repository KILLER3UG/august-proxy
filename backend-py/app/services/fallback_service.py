"""
Fallback service — read/write the sub-agent fallback configuration.

Backed by the ``config.json`` ``subAgentFallback`` key. Until this module
existed the key was write-only (the frontend wrote it, no Python path read
it). The sub-agent executor now consumes it (see ``subagent.py``) so the
config is finally live.
"""

from __future__ import annotations

from typing import Any

from app.config import settings
from app.lib.paths import data_path
from app.services.memory_store import record_config_audit

_DEFAULT_FALLBACK: dict[str, Any] = {
    "enabled": False,
    "mode": "off",
    "provider": "",
    "model": "",
}

_VALID_MODES = {"off", "session_only", "marked_subagent_only", "always"}


# ── Read / write ─────────────────────────────────────────────────────


def get_fallback() -> dict[str, Any]:
    """Return the current sub-agent fallback config (with defaults filled)."""
    fb = settings.config.get("subAgentFallback")
    if not isinstance(fb, dict):
        return dict(_DEFAULT_FALLBACK)
    merged = dict(_DEFAULT_FALLBACK)
    merged.update(fb)
    return merged


def _write_fallback(fb: dict[str, Any]) -> None:
    import json

    p = data_path("config.json")
    cfg = json.loads(p.read_text("utf-8")) if p.exists() else {}
    cfg["subAgentFallback"] = fb
    p.write_text(json.dumps(cfg, indent=2), "utf-8")
    settings.reload()


# ── CRUD ─────────────────────────────────────────────────────────────


def configure_fallback(
    enabled: bool | None = None,
    mode: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    """Update fallback fields (partial). Validates provider+model when active."""
    before = get_fallback()
    after = dict(before)

    if enabled is not None:
        after["enabled"] = bool(enabled)
    if mode is not None:
        if mode not in _VALID_MODES:
            raise ValueError(f"Invalid mode '{mode}'. Must be one of: {sorted(_VALID_MODES)}")
        after["mode"] = mode
    if provider is not None:
        after["provider"] = provider
    if model is not None:
        after["model"] = model

    # Validate provider+model only when the fallback is actually active.
    if after.get("enabled") and after.get("mode") != "off":
        prov = after.get("provider", "")
        mdl = after.get("model", "")
        if prov or mdl:
            from app.services.alias_service import validate_target
            ok, msg = validate_target(prov, mdl)
            if not ok:
                raise ValueError(msg)

    _write_fallback(after)
    record_config_audit("fallback", "configure", actor, before=before, after=after)
    return after


def test_fallback(model: str) -> dict[str, Any]:
    """Probe resolution of a model id without saving anything."""
    from app.providers.model_resolver import resolve_or_fallback

    try:
        result = resolve_or_fallback(model)
    except Exception as exc:
        return {"ok": False, "error": str(exc), "model": model}

    if not result:
        return {"ok": False, "error": "no provider available", "model": model}
    return {
        "ok": True,
        "model": result.get("model"),
        "provider": result.get("provider"),
        "alias": result.get("alias"),
        "isFallback": bool(result.get("is_fallback")),
    }
