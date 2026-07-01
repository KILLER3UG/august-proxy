"""
v4.2 — Live (STT/TTS) config service — read/write auxiliary.live in config.json.

Mirrors `model_fleet_service` — read returns defaults+overrides, write accepts
a partial dict and validates each field's shape.
"""
from __future__ import annotations
from app.services import configService
FIELDS = ('sttProvider', 'sttModel', 'ttsProvider', 'ttsModel', 'ttsVoice')
DEFAULTS: dict[str, str] = {'sttProvider': '', 'sttModel': '', 'ttsProvider': '', 'ttsModel': '', 'ttsVoice': ''}

def getLiveConfig() -> dict[str, str]:
    cfg = configService.getConfig()
    user = cfg.get('auxiliary', {}).get('live', {}) or {}
    out = DEFAULTS.copy()
    for f in FIELDS:
        if f in user:
            out[f] = user[f]
    return out

def validatePatch(patch: dict[str, object]) -> tuple[bool, str]:
    for field, value in patch.items():
        if field not in FIELDS:
            return (False, f'unknown field: {field!r} (expected one of {FIELDS})')
        if not isinstance(value, str):
            return (False, f'{field!r} must be a string (got {type(value).__name__})')
    return (True, '')

def updateLiveConfig(patch: dict[str, object]) -> tuple[bool, str, dict[str, str]]:
    ok, err = validatePatch(patch)
    if not ok:
        return (False, err, getLiveConfig())
    cfg = configService.getConfig()
    aux = cfg.setdefault('auxiliary', {})
    live = aux.setdefault('live', {})
    live.update(patch)
    configService.saveConfig(cfg)
    return (True, '', getLiveConfig())