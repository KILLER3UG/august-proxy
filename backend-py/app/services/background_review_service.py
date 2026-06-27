"""
Background review config service — read/write the background review model config.

Backed by ``config.json`` ``auxiliary.background_review`` key. The reflection
loop and auto-memory extraction read this config to determine which provider
and model to use for background tasks. If not configured or disabled, they
fall back to the chat session's provider/model (the default).
"""

from __future__ import annotations

import json
from typing import Any

from app.config import settings
from app.lib.paths import data_path

_DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "provider": "",
    "model": "",
}


def get_config() -> dict[str, Any]:
    """Return the current background review config (with defaults filled)."""
    aux = settings.config.get("auxiliary", {})
    if not isinstance(aux, dict):
        return dict(_DEFAULT_CONFIG)
    br = aux.get("background_review", {})
    if not isinstance(br, dict):
        return dict(_DEFAULT_CONFIG)
    merged = dict(_DEFAULT_CONFIG)
    merged.update(br)
    return merged


def _write_config(data: dict[str, Any]) -> None:
    p = data_path("config.json")
    cfg = json.loads(p.read_text("utf-8")) if p.exists() else {}
    cfg.setdefault("auxiliary", {})
    cfg["auxiliary"]["background_review"] = data
    p.write_text(json.dumps(cfg, indent=2), "utf-8")
    settings.reload()


def save_config(
    enabled: bool | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Update background review config fields (partial merge)."""
    current = get_config()
    if enabled is not None:
        current["enabled"] = bool(enabled)
    if provider is not None:
        current["provider"] = provider
    if model is not None:
        current["model"] = model

    _write_config(current)
    return dict(current)
