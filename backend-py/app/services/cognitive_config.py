"""Single cognitive configuration tree.

Canonical location only: ``config.json → auxiliary.cognitive``

On first load, ``ensure_defaults`` migrates legacy
``cognitive_layers`` / flat ``model_fleet`` / top-level ``brain_orchestrator``
into the tree and **removes** those legacy keys so there is one reader path.
"""

from __future__ import annotations

import os
from copy import deepcopy
from typing import Any

from app.json_narrowing import as_dict, as_float
from app.services import config_service
from app.services.model_fleet_service import DEFAULTS as FLEET_DEFAULTS, ROLES as FLEET_ROLES, invalidate_cache as invalidate_fleet

DEFAULT_BOOT: dict[str, bool] = {
    'db_writer': True,
    'cron_scheduler': True,
    'consolidation': True,
    'backfill_workbench': True,
    'environment_watcher': False,
}

DEFAULT_FEATURES: dict[str, bool] = {
    'heuristics': True,
    'execution_state': True,
    'scratchpad': True,
    'tool_guardrails': True,
    'progressive_disclosure': True,
    'prompt_caching': True,
    'cognitive_budget': True,
    'daemons': True,
    'blackboard': True,
    'env_watcher': False,
    'verifier_reflex': True,
    'skill_genesis': True,
    'vector_memory': True,
    'graph_memory': True,
}

DEFAULT_ORCHESTRATOR: dict[str, object] = {}


def _env_bool(key: str) -> bool | None:
    if key not in os.environ:
        return None
    return os.environ[key].strip().lower() in ('1', 'true', 'yes', 'on')


def _merge_bool_map(defaults: dict[str, bool], *sources: dict[str, object]) -> dict[str, bool]:
    out = dict(defaults)
    for src in sources:
        for k, v in src.items():
            if isinstance(v, bool):
                out[k] = v
            elif isinstance(v, (int, float, str)):
                out[k] = bool(v) if not isinstance(v, str) else v.strip().lower() in ('1', 'true', 'yes', 'on')
    return out


def get_raw_config() -> dict[str, object]:
    return config_service.getConfig()


def get_cognitive() -> dict[str, object]:
    """Return the merged cognitive tree from ``auxiliary.cognitive`` only + env overlays."""
    cfg = get_raw_config()
    aux = as_dict(cfg.get('auxiliary'), {})
    cognitive = as_dict(aux.get('cognitive'), {})

    nested_boot = as_dict(cognitive.get('boot'), {})
    nested_features = as_dict(cognitive.get('features'), {})
    nested_fleet = as_dict(cognitive.get('fleet'), {})
    nested_orch = as_dict(cognitive.get('orchestrator'), {})

    boot = _merge_bool_map(DEFAULT_BOOT, nested_boot)
    features = _merge_bool_map(DEFAULT_FEATURES, nested_features)
    if 'environment_watcher' in boot and 'env_watcher' not in nested_features:
        features['env_watcher'] = boot['environment_watcher']

    fleet = dict(FLEET_DEFAULTS)
    for role in FLEET_ROLES:
        if role in nested_fleet and isinstance(nested_fleet[role], str):
            fleet[role] = str(nested_fleet[role])

    master = os.environ.get('AUGUST_COGNITIVE_BOOT', '1').strip().lower()
    if master in ('0', 'false', 'no', 'off'):
        boot = {k: False for k in DEFAULT_BOOT}

    for name in DEFAULT_BOOT:
        env_val = _env_bool(f'AUGUST_LAYER_{name.upper()}')
        if env_val is not None:
            boot[name] = env_val
    for env_key, boot_key in (
        ('AUGUST_LAYER_SCHEDULER', 'cron_scheduler'),
        ('AUGUST_LAYER_SLEEP_CYCLE', 'consolidation'),
        ('AUGUST_LAYER_ENV_WATCHER', 'environment_watcher'),
    ):
        env_val = _env_bool(env_key)
        if env_val is not None:
            boot[boot_key] = env_val

    interval = 86400.0
    raw_interval = cognitive.get('consolidation_interval_s') or cognitive.get('consolidationIntervalS')
    if raw_interval is not None:
        interval = max(60.0, as_float(raw_interval, interval))
    env_interval = os.environ.get('AUGUST_CONSOLIDATION_INTERVAL_S')
    if env_interval:
        try:
            interval = max(60.0, float(env_interval))
        except ValueError:
            pass

    return {
        'boot': boot,
        'features': features,
        'fleet': fleet,
        'orchestrator': {**DEFAULT_ORCHESTRATOR, **nested_orch},
        'consolidation_interval_s': interval,
    }


def ensure_defaults() -> dict[str, object]:
    """Ensure ``auxiliary.cognitive`` exists; migrate and drop legacy keys once."""
    cfg = get_raw_config()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux

    dirty = False
    cognitive = aux.get('cognitive')
    if not isinstance(cognitive, dict):
        cognitive = {}
        aux['cognitive'] = cognitive
        dirty = True

    # One-shot migrate from legacy locations into the tree.
    # If a legacy key reappears on disk, merge then delete so readers never dual-read.
    legacy_layers = as_dict(aux.get('cognitive_layers'), {})
    legacy_fleet = as_dict(aux.get('model_fleet'), {})
    top_orch = as_dict(cfg.get('brain_orchestrator'), {})

    # Fill missing boot keys from defaults; migrate legacy layer names once.
    boot_src: dict[str, object] = {}
    for old, new in (
        ('scheduler', 'cron_scheduler'),
        ('cron_scheduler', 'cron_scheduler'),
        ('sleep_cycle', 'consolidation'),
        ('consolidation', 'consolidation'),
        ('db_writer', 'db_writer'),
        ('backfill_workbench', 'backfill_workbench'),
        ('environment_watcher', 'environment_watcher'),
        ('env_watcher', 'environment_watcher'),
    ):
        if old in legacy_layers:
            boot_src[new] = legacy_layers[old]
    prev_boot = as_dict(cognitive.get('boot'), {})
    next_boot = _merge_bool_map(DEFAULT_BOOT, boot_src, prev_boot)
    if 'boot' not in cognitive or not isinstance(cognitive.get('boot'), dict) or next_boot != prev_boot:
        cognitive['boot'] = next_boot
        dirty = True

    # Always fill missing feature keys from defaults (explicit False stays False).
    # Keeps memories / skill genesis / etc. on for upgrades that add new flags.
    prev_features = as_dict(cognitive.get('features'), {})
    next_features = _merge_bool_map(DEFAULT_FEATURES, legacy_layers, prev_features)
    if 'features' not in cognitive or not isinstance(cognitive.get('features'), dict) or next_features != prev_features:
        cognitive['features'] = next_features
        dirty = True

    if 'fleet' not in cognitive or not isinstance(cognitive.get('fleet'), dict):
        fleet = dict(FLEET_DEFAULTS)
        for role in FLEET_ROLES:
            if role in legacy_fleet and isinstance(legacy_fleet[role], str):
                fleet[role] = str(legacy_fleet[role])
        cognitive['fleet'] = fleet
        dirty = True
    elif legacy_fleet:
        existing_fleet = as_dict(cognitive.get('fleet'), {})
        fleet = dict(FLEET_DEFAULTS)
        for role in FLEET_ROLES:
            if role in existing_fleet and isinstance(existing_fleet[role], str):
                fleet[role] = str(existing_fleet[role])
        for role in FLEET_ROLES:
            if role in legacy_fleet and isinstance(legacy_fleet[role], str):
                fleet[role] = str(legacy_fleet[role])
        cognitive['fleet'] = fleet
        dirty = True

    if 'orchestrator' not in cognitive or not isinstance(cognitive.get('orchestrator'), dict):
        cognitive['orchestrator'] = {**DEFAULT_ORCHESTRATOR, **top_orch}
        dirty = True
    elif top_orch:
        # Legacy top-level wins for overlapping keys (explicit file edit).
        cognitive['orchestrator'] = {
            **as_dict(cognitive.get('orchestrator'), {}),
            **top_orch,
        }
        dirty = True

    if 'consolidation_interval_s' not in cognitive:
        raw = aux.get('consolidation_interval_s') or aux.get('consolidationIntervalS')
        try:
            cognitive['consolidation_interval_s'] = max(60.0, float(raw)) if raw is not None else 86400.0
        except (TypeError, ValueError):
            cognitive['consolidation_interval_s'] = 86400.0
        dirty = True

    # Drop legacy keys — single reader path after this.
    for dead in ('cognitive_layers', 'consolidation_interval_s', 'consolidationIntervalS'):
        if dead in aux:
            del aux[dead]
            dirty = True
    if 'model_fleet' in aux:
        del aux['model_fleet']
        dirty = True
    if 'brain_orchestrator' in cfg:
        del cfg['brain_orchestrator']
        dirty = True

    if dirty:
        config_service.saveConfig(cfg)
        invalidate_fleet()
    return get_cognitive()


def get_boot_layers() -> dict[str, bool]:
    tree = get_cognitive()
    boot = as_dict(tree.get('boot'), {})
    return {k: bool(boot.get(k, DEFAULT_BOOT.get(k, False))) for k in DEFAULT_BOOT}


def get_features() -> dict[str, bool]:
    tree = get_cognitive()
    features = as_dict(tree.get('features'), {})
    return {k: bool(features.get(k, DEFAULT_FEATURES.get(k, False))) for k in DEFAULT_FEATURES}


def get_consolidation_interval_s() -> float:
    tree = get_cognitive()
    return max(60.0, as_float(tree.get('consolidation_interval_s'), 86400.0))


def update_cognitive(patch: dict[str, object]) -> dict[str, object]:
    """Partial update of the cognitive tree only (no legacy dual-write)."""
    ensure_defaults()
    cfg = get_raw_config()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux
    cognitive = aux.get('cognitive')
    if not isinstance(cognitive, dict):
        cognitive = {}
        aux['cognitive'] = cognitive

    for section in ('boot', 'features', 'fleet', 'orchestrator'):
        if section in patch and isinstance(patch[section], dict):
            current = cognitive.get(section)
            if not isinstance(current, dict):
                current = {}
            current = {**current, **patch[section]}  # type: ignore[dict-item]
            cognitive[section] = current

    if 'consolidation_interval_s' in patch:
        try:
            cognitive['consolidation_interval_s'] = max(60.0, float(patch['consolidation_interval_s']))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            pass

    config_service.saveConfig(cfg)
    invalidate_fleet()
    return get_cognitive()


def to_public() -> dict[str, Any]:
    return deepcopy(get_cognitive())
