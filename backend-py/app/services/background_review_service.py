"""
Background review config service — read/write the background review model config.

Backed by ``config.json`` ``auxiliary.background_review`` key. Background tasks
read this config to determine which model to use for each task. If not
configured or disabled, they fall back to the chat session's model (the
default). Restored in 0.17.0 — the config router and the Models → Background &
Reflection settings tab both depend on it.

Three independent model selectors are supported, each with the gateway that
serves it — a model id does not identify a provider:
  • reviewModel      + reviewModelProvider      — reviewing and summarising
  • reflectionModel  + reflectionModelProvider — self-evaluation / learning loop
  • autoMemoryModel  + autoMemoryModelProvider — extracting and storing facts

When a selector is empty the chat session's model is used for that task. An
empty provider means "resolve by id", which is the legacy behaviour and picks
whichever configured provider lists that id first.
"""

from __future__ import annotations

import json

from app.atomic_write import write_json_atomic
from app.config import settings
from app.lib.paths import dataPath
from app.services.memory_store import record_config_audit

_DEFAULTConfig: dict[str, object] = {
    'enabled': True,
    'reviewModel': '',
    'reviewModelProvider': '',
    'reflectionModel': '',
    'reflectionModelProvider': '',
    'autoMemoryModel': '',
    'autoMemoryModelProvider': '',
}


def getConfig() -> dict[str, object]:
    """Return the current background review config (with defaults filled)."""
    aux = settings.config.get('auxiliary', {})
    if not isinstance(aux, dict):
        return dict(_DEFAULTConfig)
    br = aux.get('background_review', {})
    if not isinstance(br, dict):
        return dict(_DEFAULTConfig)
    merged = dict(_DEFAULTConfig)
    merged.update(br)
    return merged


def _writeConfig(data: dict[str, object]) -> None:
    p = dataPath('config.json')
    cfg = json.loads(p.read_text('utf-8')) if p.exists() else {}
    cfg.setdefault('auxiliary', {})
    cfg['auxiliary']['background_review'] = data
    write_json_atomic(p, cfg, indent=2)
    settings.reload()


def saveConfig(
    enabled: bool | None = None,
    review_model: str | None = None,
    reflection_model: str | None = None,
    auto_memory_model: str | None = None,
    review_model_provider: str | None = None,
    reflection_model_provider: str | None = None,
    auto_memory_model_provider: str | None = None,
    actor: str = 'system',
) -> dict[str, object]:
    """Update background review config fields (partial merge).

    Also performs a one-time migration from the legacy ``provider``/``model``
    schema: if ``reviewModel`` is empty but the legacy ``model`` field is set,
    the legacy value is promoted to ``reviewModel``.
    """
    current = getConfig()
    before = dict(current)
    if not current.get('reviewModel') and current.get('model'):
        current['reviewModel'] = current.pop('model', '')
    current.pop('provider', None)
    current.pop('model', None)
    if enabled is not None:
        current['enabled'] = bool(enabled)
    if review_model is not None:
        current['reviewModel'] = review_model
    if reflection_model is not None:
        current['reflectionModel'] = reflection_model
    if auto_memory_model is not None:
        current['autoMemoryModel'] = auto_memory_model
    if review_model_provider is not None:
        current['reviewModelProvider'] = review_model_provider
    if reflection_model_provider is not None:
        current['reflectionModelProvider'] = reflection_model_provider
    if auto_memory_model_provider is not None:
        current['autoMemoryModelProvider'] = auto_memory_model_provider
    result = {k: current.get(k, _DEFAULTConfig.get(k)) for k in _DEFAULTConfig}
    _writeConfig(result)
    record_config_audit('background_review', 'update', actor, before=before, after=dict(result))
    return dict(result)


#: The three background selectors, each as ``(modelKey, providerKey)``. They are
#: read together by ``resolveSelector`` and never apart — a model id does not
#: identify a gateway, and resolving by id alone ran the task on whichever
#: configured provider happened to list that model first.
SELECTORS: dict[str, tuple[str, str]] = {
    'review': ('reviewModel', 'reviewModelProvider'),
    'reflection': ('reflectionModel', 'reflectionModelProvider'),
    'autoMemory': ('autoMemoryModel', 'autoMemoryModelProvider'),
}


def resolveSelector(task: str) -> tuple[str, str]:
    """``(model, provider)`` for 'review' | 'reflection' | 'autoMemory'."""
    keys = SELECTORS.get(task)
    if not keys:
        return '', ''
    cfg = getConfig()
    return str(cfg.get(keys[0]) or ''), str(cfg.get(keys[1]) or '')
