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
from app.config import settings
from app.jsonUtils import as_str, as_dict, as_list, as_int
from app.lib.paths import dataPath
from app.services.memoryStore import recordConfigAudit
_DEFAULTConfig: dict[str, object] = {'enabled': False, 'reviewModel': '', 'reflectionModel': '', 'autoMemoryModel': ''}

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
    p.write_text(json.dumps(cfg, indent=2), 'utf-8')
    settings.reload()

def saveConfig(enabled: bool | None=None, reviewModel: str | None=None, reflectionModel: str | None=None, autoMemoryModel: str | None=None, actor: str='system') -> dict[str, object]:
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
    if reviewModel is not None:
        current['reviewModel'] = reviewModel
    if reflectionModel is not None:
        current['reflectionModel'] = reflectionModel
    if autoMemoryModel is not None:
        current['autoMemoryModel'] = autoMemoryModel
    result = {k: current.get(k, _DEFAULTConfig.get(k)) for k in _DEFAULTConfig}
    _writeConfig(result)
    recordConfigAudit('background_review', 'update', actor, before=before, after=dict(result))
    return dict(result)