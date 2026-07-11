"""
v4.1 — Model Fleet service — read/write auxiliary.model_fleet in config.json.

The fleet maps four cognitive roles (cortex / cerebellum / hippocampus / prefrontal)
to model ids. Empty `cortex` means "use the session's primary model" (the
caller's responsibility — this module just returns the empty string).

The actual `getModelForRole()` lookup still lives in
`app/services/workbench/model_fleet.py` — that module reads config.json
inline. This service adds a write path + a thin read path that returns the
merged fleet for the UI.
"""
from __future__ import annotations
from app.jsonUtils import as_dict, as_str
from app.services import config_service
ROLES = ('cortex', 'cerebellum', 'hippocampus', 'prefrontal')
DEFAULTS: dict[str, str] = {'cortex': '', 'cerebellum': 'claude-3-haiku-20240307', 'hippocampus': 'claude-3-haiku-20240307', 'prefrontal': 'claude-3-5-sonnet-20240620'}

def getFleet() -> dict[str, str]:
    """Return the merged fleet (defaults + user overrides)."""
    cfg = config_service.getConfig()
    user = as_dict(as_dict(cfg.get('auxiliary'), {}).get('model_fleet'), {})
    out = DEFAULTS.copy()
    for role in ROLES:
        if role in user:
            out[role] = as_str(user.get(role))
    return out

def validateRoles(patch: dict[str, object]) -> tuple[bool, str]:
    """Validate the patch: each key must be a known role and value must be a string.

    Returns (ok, error_message). On error, error_message names the offender.
    """
    for role, value in patch.items():
        if role not in ROLES:
            return (False, f'unknown role: {role!r} (expected one of {ROLES})')
        if not isinstance(value, str):
            return (False, f'{role!r} must be a string (got {type(value).__name__})')
    return (True, '')

def updateFleet(patch: dict[str, object]) -> tuple[bool, str, dict[str, str]]:
    """Validate, persist, and return the new merged fleet."""
    ok, err = validateRoles(patch)
    if not ok:
        return (False, err, getFleet())
    cfg = config_service.getConfig()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux
    fleet = aux.get('model_fleet')
    if not isinstance(fleet, dict):
        fleet = {}
        aux['model_fleet'] = fleet
    fleet.update(patch)
    config_service.saveConfig(cfg)
    return (True, '', getFleet())