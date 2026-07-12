"""
Fallback service — read/write the sub-agent fallback configuration.

Backed by the ``config.json`` ``subAgentFallback`` key. Until this module
existed the key was write-only (the frontend wrote it, no Python path read
it). The sub-agent executor now consumes it (see ``subagent.py``) so the
config is finally live.
"""

from __future__ import annotations
from app.config import settings
from app.jsonUtils import as_str, write_json_atomic
from app.lib.paths import dataPath
from app.services.memory_store import recordConfigAudit

_DEFAULTFallback: dict[str, object] = {'enabled': False, 'mode': 'off', 'provider': '', 'model': ''}
_VALIDModes = {'off', 'session_only', 'marked_subagent_only', 'always'}


def getFallback() -> dict[str, object]:
    """Return the current sub-agent fallback config (with defaults filled)."""
    fb = settings.config.get('subAgentFallback')
    if not isinstance(fb, dict):
        return dict(_DEFAULTFallback)
    merged = dict(_DEFAULTFallback)
    merged.update(fb)
    return merged


def _writeFallback(fb: dict[str, object]) -> None:
    import json

    p = dataPath('config.json')
    cfg = json.loads(p.read_text('utf-8')) if p.exists() else {}
    cfg['subAgentFallback'] = fb
    write_json_atomic(p, cfg, indent=2)
    settings.reload()


def configureFallback(
    enabled: bool | None = None,
    mode: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    actor: str = 'system',
) -> dict[str, object]:
    """Update fallback fields (partial). Validates provider+model when active."""
    before = getFallback()
    after = dict(before)
    if enabled is not None:
        after['enabled'] = bool(enabled)
    if mode is not None:
        if mode not in _VALIDModes:
            raise ValueError(f"Invalid mode '{mode}'. Must be one of: {sorted(_VALIDModes)}")
        after['mode'] = mode
    if provider is not None:
        after['provider'] = provider
    if model is not None:
        after['model'] = model
    if after.get('enabled') and as_str(after.get('mode'), '') != 'off':
        prov = as_str(after.get('provider'), '')
        mdl = as_str(after.get('model'), '')
        if prov or mdl:
            from app.services.alias_service import validateTarget

            ok, msg = validateTarget(prov, mdl)
            if not ok:
                raise ValueError(msg)
    _writeFallback(after)
    recordConfigAudit('fallback', 'configure', actor, before=before, after=after)
    return after


def testFallback(model: str) -> dict[str, object]:
    """Probe resolution of a model id without saving anything."""
    from app.providers.modelResolver import resolveOrFallback

    try:
        result = resolveOrFallback(model)
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'model': model}
    if not result:
        return {'ok': False, 'error': 'no provider available', 'model': model}
    return {
        'ok': True,
        'model': result.get('model'),
        'provider': result.get('provider'),
        'alias': result.get('alias'),
        'isFallback': bool(result.get('is_fallback')),
    }
