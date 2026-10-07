"""
Model fleet — single source of truth under ``auxiliary.cognitive.fleet``.

Settings UI and runtime both use this module. ``ensure_defaults`` migrates
any legacy flat ``model_fleet`` once; after that only the nested tree is read.

Each role has TWO values: the model id under ``fleet`` and the gateway that
serves it under ``fleetProviders``. They are read together by
``resolveRoleModel`` — never separately — because a model id does not identify
a gateway: ``stepfun/step-3.7-flash`` is listed by OpenRouter and KiloCode both,
and resolving by id alone silently runs the role on whichever provider happens
to be configured first.
"""

from __future__ import annotations

from app.json_narrowing import as_dict, as_str
from app.services import config_service

ROLES = (
    'cortex',
    'cerebellum',
    'hippocampus',
    'prefrontal',
    # Chat role routing (surpass #2). Blank = use the session's selected model.
    'chat_default',
    'chat_smol',
    'chat_slow',
    'chat_plan',
    'chat_vision',
    # Fallback chain (comma-separated model ids) + context-promotion model.
    # Blank everywhere by default — background jobs fall back to the session
    # model; nothing hardcodes a vendor model id.
    'chat_chain',
    'chat_context_promotion',
)
DEFAULTS: dict[str, str] = dict.fromkeys(ROLES, '')


def getFleetProviders() -> dict[str, str]:
    """The gateway configured per role — same key set as ``getFleet()``."""
    try:
        from app.services.cognitive_config import ensure_defaults, get_cognitive

        ensure_defaults()
        tree = get_cognitive()
        user = as_dict(tree.get('fleetProviders'), {})
    except Exception:
        cfg = config_service.getConfig()
        aux = as_dict(cfg.get('auxiliary'), {})
        cognitive = as_dict(aux.get('cognitive'), {})
        user = as_dict(cognitive.get('fleetProviders'), {})
    return {role: as_str(user.get(role)) for role in ROLES}


def resolveRoleModel(role: str) -> tuple[str, str]:
    """``(model, provider)`` for a role. The only accessor that may be used to
    build a client for a role — taking the model from ``getFleet()`` and a
    provider from nowhere is how a role ends up running on another gateway."""
    return getModelForRole(role), getFleetProviders().get(role, '')


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
    """The model id configured for a role, or '' when it is unset."""
    fleet = getFleet()
    if role in fleet:
        return fleet[role]
    # An unknown role used to answer with the CORTEX model, so a typo in a caller
    # looked like a configured role that happened to pick a strange model. Empty
    # means "not configured", which every caller already handles.
    return ''


def _validateRoleMap(label: str, patch: dict[str, object]) -> tuple[bool, str]:
    for role, value in patch.items():
        if role not in ROLES:
            return (False, f'{label}: unknown role {role!r} (expected one of {ROLES})')
        if not isinstance(value, str):
            return (False, f'{label}.{role!r} must be a string (got {type(value).__name__})')
    return (True, '')


def validateRoles(patch: dict[str, object]) -> tuple[bool, str]:
    return _validateRoleMap('fleet', patch)


def _splitPatch(patch: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    """Accept both request shapes: the flat ``{role: model}`` the UI has always
    sent, and the wrapped ``{models: {..}, providers: {..}}`` that carries a
    gateway per role."""
    if 'models' in patch or 'providers' in patch:
        models = as_dict(patch.get('models'), {})
        providers = as_dict(patch.get('providers'), {})
        return models, providers
    return patch, {}


def fleetState() -> dict[str, dict[str, str]]:
    """The pair the settings UI reads: models and providers, one key per role."""
    return {'models': getFleet(), 'providers': getFleetProviders()}


def updateFleet(patch: dict[str, object]) -> tuple[bool, str, dict[str, dict[str, str]]]:
    """Validate, persist under cognitive.fleet + cognitive.fleetProviders, and
    return the merged state."""
    models, providers = _splitPatch(patch)
    for label, values in (('fleet', models), ('fleetProviders', providers)):
        ok, err = _validateRoleMap(label, values)
        if not ok:
            return (False, err, fleetState())
    write: dict[str, object] = {'fleet': models, 'fleetProviders': providers}
    try:
        from app.services.cognitive_config import ensure_defaults, update_cognitive

        ensure_defaults()
        update_cognitive(write)
    except Exception:
        # Fallback write if cognitive_config is unavailable.
        cfg = config_service.getConfig()
        aux = cfg.get('auxiliary')
        if not isinstance(aux, dict):
            aux = {}
            cfg['auxiliary'] = aux
        cognitive = aux.get('cognitive')
        if not isinstance(cognitive, dict):
            cognitive = {}
            aux['cognitive'] = cognitive
        for section in ('fleet', 'fleetProviders'):
            stored = write.get(section)
            if not isinstance(stored, dict):
                continue
            current = cognitive.get(section)
            if not isinstance(current, dict):
                current = {}
            current.update(stored)
            cognitive[section] = current
        config_service.saveConfig(cfg)
    return (True, '', fleetState())
