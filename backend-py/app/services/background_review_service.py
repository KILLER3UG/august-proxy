"""
Background review config service — read/write the background review model config.

Backed by ``config.json`` ``auxiliary.background_review`` key. The reflection
loop and auto-memory extraction read this config to determine which model to
use for each background task. If not configured or disabled, they fall back
to the chat session's model (the default).

Three independent model selectors are supported:
  • reviewModel      — reviewing and summarising conversations
  • reflectionModel  — agent self-evaluation / learning loop
  • autoMemoryModel  — extracting facts and storing them in memory

Each field is a model alias/id that resolves to a real provider+model.
When empty, the chat session's model is used for that task.
"""

from __future__ import annotations

import json
from typing import Any

from app.config import settings
from app.lib.paths import data_path
from app.services.memory_store import record_config_audit

_DEFAULT_CONFIG: dict[str, Any] = {
    "enabled": False,
    "reviewModel": "",
    "reflectionModel": "",
    "autoMemoryModel": "",
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
    review_model: str | None = None,
    reflection_model: str | None = None,
    auto_memory_model: str | None = None,
    actor: str = "system",
) -> dict[str, Any]:
    """Update background review config fields (partial merge).

    Also performs a one-time migration from the legacy ``provider``/``model``
    schema: if ``reviewModel`` is empty but the legacy ``model`` field is set,
    the legacy value is promoted to ``reviewModel``.
    """
    current = get_config()
    before = dict(current)

    # One-time migration from legacy {provider, model} → reviewModel.
    if not current.get("reviewModel") and current.get("model"):
        current["reviewModel"] = current.pop("model", "")
    # Drop the legacy provider field — providers are now resolved from the model.
    current.pop("provider", None)
    current.pop("model", None)

    if enabled is not None:
        current["enabled"] = bool(enabled)
    if review_model is not None:
        current["reviewModel"] = review_model
    if reflection_model is not None:
        current["reflectionModel"] = reflection_model
    if auto_memory_model is not None:
        current["autoMemoryModel"] = auto_memory_model

    # Ensure only the canonical keys are persisted.
    result = {k: current.get(k, _DEFAULT_CONFIG.get(k)) for k in _DEFAULT_CONFIG}
    _write_config(result)
    record_config_audit("background_review", "update", actor, before=before, after=dict(result))
    return dict(result)
