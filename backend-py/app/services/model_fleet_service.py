"""
Model fleet — single source of truth under ``auxiliary.cognitive.fleet``.

Settings UI and runtime both use this module. ``ensure_defaults`` migrates
any legacy flat ``model_fleet`` once; after that only the nested tree is read.
"""

from __future__ import annotations

from app.json_narrowing import as_dict, as_str
from app.services import config_service

ROLES = ('cortex', 'cerebellum', 'hippocampus', 'prefrontal')
DEFAULTS: dict[str, str] = {
    'cortex': '',
    'cerebellum': 'claude-3-haiku-20240307',
    'hippocampus': 'claude-3-haiku-20240307',
    'prefrontal': 'claude-3-5-sonnet-20240620',
}


def invalidate_cache() -> None:
    """No-op retained for API compatibility (always re-reads config)."""
    return None


_resetCache = invalidate_cache
_reset_cache = invalidate_cache


def getFleet() -> dict[str, str]:
    """Return the merged fleet (defaults + ``auxiliary.cognitive.fleet``)."""
    try:
        from app.services.cognitive_config import ensure_defaults, get_cognitive

        ensure_defaults()
        tree = get_cognitive()
        user = as_dict(tree.get('fleet'), {})
    except Exception:
        cfg = config_service.getConfig()
        aux = as_dict(cfg.get('auxiliary'), {})
        cognitive = as_dict(aux.get('cognitive'), {})
        user = as_dict(cognitive.get('fleet'), {})
    out = DEFAULTS.copy()
    for role in ROLES:
        if role in user:
            out[role] = as_str(user.get(role))
    return out


def getModelForRole(role: str) -> str:
    fleet = getFleet()
    if role in fleet:
        return fleet[role]
    return fleet.get('cortex', '')


def validateRoles(patch: dict[str, object]) -> tuple[bool, str]:
    for role, value in patch.items():
        if role not in ROLES:
            return (False, f'unknown role: {role!r} (expected one of {ROLES})')
        if not isinstance(value, str):
            return (False, f'{role!r} must be a string (got {type(value).__name__})')
    return (True, '')


def updateFleet(patch: dict[str, object]) -> tuple[bool, str, dict[str, str]]:
    """Validate, persist under cognitive.fleet, return merged fleet."""
    ok, err = validateRoles(patch)
    if not ok:
        return (False, err, getFleet())
    try:
        from app.services.cognitive_config import ensure_defaults, update_cognitive

        ensure_defaults()
        update_cognitive({'fleet': patch})
    except Exception:
        # Fallback write if cognitive_config unavailable
        cfg = config_service.getConfig()
        aux = cfg.get('auxiliary')
        if not isinstance(aux, dict):
            aux = {}
            cfg['auxiliary'] = aux
        cognitive = aux.get('cognitive')
        if not isinstance(cognitive, dict):
            cognitive = {}
            aux['cognitive'] = cognitive
        fleet = cognitive.get('fleet')
        if not isinstance(fleet, dict):
            fleet = {}
            cognitive['fleet'] = fleet
        fleet.update(patch)
        config_service.saveConfig(cfg)
    return (True, '', getFleet())
