"""
v4.2 — Live (STT/TTS) config service — read/write auxiliary.live in config.json.
"""

from __future__ import annotations

from app.json_narrowing import as_dict, as_str
from app.services import config_service

FIELDS = ('sttProvider', 'sttModel', 'ttsProvider', 'ttsModel', 'ttsVoice')
DEFAULTS: dict[str, str] = {
    'sttProvider': '',
    'sttModel': '',
    'ttsProvider': '',
    'ttsModel': '',
    'ttsVoice': '',
}


def getLiveConfig() -> dict[str, str]:
    cfg = config_service.getConfig()
    user = as_dict(as_dict(cfg.get('auxiliary'), {}).get('live'), {})
    out = DEFAULTS.copy()
    for f in FIELDS:
        if f in user:
            out[f] = as_str(user.get(f))
    return out


def getLiveConfigWithStatus() -> dict[str, object]:
    """Live config plus whether server STT/TTS is actually usable."""
    base = getLiveConfig()
    stt_provider = as_str(base.get('sttProvider'))
    tts_provider = as_str(base.get('ttsProvider'))
    stt_ready = False
    tts_ready = False
    if stt_provider:
        try:
            from app.services.live_speech import _resolve_provider

            stt_ready = _resolve_provider(stt_provider) is not None
        except Exception:
            stt_ready = False
    if tts_provider:
        try:
            from app.services.live_speech import _resolve_provider

            tts_ready = _resolve_provider(tts_provider) is not None
        except Exception:
            tts_ready = False
    return {
        **base,
        'sttReady': stt_ready,
        'ttsReady': tts_ready,
        'sttMode': 'server' if stt_ready else 'browser',
        'ttsMode': 'server' if tts_ready else 'browser',
        'note': (
            'Server STT/TTS only when a provider with API key is selected. '
            'Empty provider = browser Web Speech / speechSynthesis.'
        ),
    }


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
    cfg = config_service.getConfig()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux
    live = aux.get('live')
    if not isinstance(live, dict):
        live = {}
        aux['live'] = live
    live.update(patch)
    config_service.saveConfig(cfg)
    return (True, '', getLiveConfig())
