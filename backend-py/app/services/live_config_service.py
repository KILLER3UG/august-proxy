"""
v4.2 — Live (STT/TTS) config service — read/write auxiliary.live in config.json.

Mirrors `model_fleet_service` — read returns defaults+overrides, write accepts
a partial dict and validates each field's shape.
"""

from __future__ import annotations

from typing import Any

from app.services import config_service

FIELDS = ("sttProvider", "sttModel", "ttsProvider", "ttsModel", "ttsVoice")

DEFAULTS: dict[str, str] = {
    "sttProvider": "",  # empty = use browser SpeechRecognition (default)
    "sttModel":    "",
    "ttsProvider": "",  # empty = use browser speechSynthesis (default)
    "ttsModel":    "",
    "ttsVoice":    "",
}


def get_live_config() -> dict[str, str]:
    cfg = config_service.get_config()
    user = cfg.get("auxiliary", {}).get("live", {}) or {}
    out = DEFAULTS.copy()
    for f in FIELDS:
        if f in user:
            out[f] = user[f]
    return out


def validate_patch(patch: dict[str, Any]) -> tuple[bool, str]:
    for field, value in patch.items():
        if field not in FIELDS:
            return False, f"unknown field: {field!r} (expected one of {FIELDS})"
        if not isinstance(value, str):
            return False, f"{field!r} must be a string (got {type(value).__name__})"
    return True, ""


def update_live_config(patch: dict[str, Any]) -> tuple[bool, str, dict[str, str]]:
    ok, err = validate_patch(patch)
    if not ok:
        return False, err, get_live_config()
    cfg = config_service.get_config()
    aux = cfg.setdefault("auxiliary", {})
    live = aux.setdefault("live", {})
    live.update(patch)
    config_service.save_config(cfg)
    return True, "", get_live_config()
