"""
Alias service — single source of truth for model-alias CRUD.

Shared by the agent-callable alias tools and the HTTP routes (``/api/manage``
and ``/api/config/model-aliases``). Centralises read/write of the
``config.json`` ``modelAliases`` list, adds provider+model validation, reloads
settings so resolvers see changes immediately, invalidates the model cache so
the dropdown refreshes, and records every change to the config audit log.
"""
from __future__ import annotations
from app.config import settings
from app.lib.paths import dataPath
from app.services.memoryStore import recordConfigAudit
from app.typeAliases import AliasDict

def listAliases() -> list[AliasDict]:
    """Return all model-alias entries (full records, not just names)."""
    import json
    p = dataPath('config.json')
    if not p.exists():
        return []
    try:
        cfg = json.loads(p.read_text('utf-8'))
    except (OSError, json.JSONDecodeError):
        return []
    aliases = cfg.get('modelAliases', [])
    return aliases if isinstance(aliases, list) else []

def _writeAliases(aliases: list[AliasDict]) -> None:
    import json
    p = dataPath('config.json')
    cfg = json.loads(p.read_text('utf-8')) if p.exists() else {}
    cfg['modelAliases'] = aliases
    p.write_text(json.dumps(cfg, indent=2), 'utf-8')
    settings.reload()
    try:
        from app.services import modelService
        modelService.invalidate_cache()
    except Exception:
        pass

def _find(alias: str) -> AliasDict | None:
    for a in listAliases():
        if a.get('alias') == alias:
            return a
    return None

def _providerNames() -> set[str]:
    """All known provider names + aliases (templates and custom)."""
    names: set[str] = set()
    try:
        from app.providers import resolver as providerResolver
        from app.providers.template_loader import get_templates
        # Template names + aliases
        for t in get_templates():
            names.add(t.get('name', ''))
            for a in t.get('aliases', []) or []:
                names.add(a)
        # Custom store entries (already included in resolver.listAvailable
        # for enabled+keyed entries, but list all names regardless of key state)
        from app.services import configService
        store = configService.getProvidersStore()
        for entry in store.get('providers', []):
            names.add(entry.get('name', ''))
    except Exception:
        pass
    names.discard('')
    return names

def validateTarget(targetProvider: str, targetModel: str) -> tuple[bool, str]:
    """Validate that provider (strict) and model (loose) are plausible.

    Returns ``(ok, message)``. An unknown provider is a hard error; an
    unknown model is a soft warning (it may still be valid upstream).
    """
    if not targetProvider:
        return (False, 'target_provider is required')
    if targetProvider not in _providerNames():
        return (False, f"Unknown provider '{targetProvider}'")
    if not targetModel:
        return (False, 'target_model is required')
    return (True, '')

def createAlias(alias: str, targetModel: str, targetProvider: str, actor: str='system', displayAlias: str='') -> AliasDict:
    """Create or upsert a model alias. Returns the stored entry."""
    alias = (alias or '').strip()
    if not alias:
        raise ValueError('alias is required')
    ok, msg = validateTarget(targetProvider, targetModel)
    if not ok:
        raise ValueError(msg)
    aliases = listAliases()
    entry: AliasDict = {'alias': alias, 'targetModel': targetModel, 'targetProvider': targetProvider}
    if displayAlias:
        entry['displayAlias'] = displayAlias
    before = _find(alias)
    if before is not None:
        beforeCopy = dict(before)
        before.update(entry)
        entry = before
    else:
        beforeCopy = None
        aliases.append(entry)
    _writeAliases(aliases)
    recordConfigAudit('alias', 'create' if beforeCopy is None else 'upsert', actor, before=beforeCopy, after=entry)
    return entry

def updateAlias(alias: str, targetModel: str | None=None, targetProvider: str | None=None, actor: str='system') -> AliasDict:
    """Update an existing alias. Raises if not found."""
    aliases = listAliases()
    existing = next((a for a in aliases if a.get('alias') == alias), None)
    if existing is None:
        raise KeyError(f"Alias '{alias}' not found")
    before = dict(existing)
    newModel = targetModel if targetModel is not None else existing.get('targetModel', '')
    newProvider = targetProvider if targetProvider is not None else existing.get('targetProvider', '')
    ok, msg = validateTarget(newProvider, newModel)
    if not ok:
        raise ValueError(msg)
    if targetModel is not None:
        existing['targetModel'] = targetModel
    if targetProvider is not None:
        existing['targetProvider'] = targetProvider
    _writeAliases(aliases)
    recordConfigAudit('alias', 'update', actor, before=before, after=existing)
    return existing

def deleteAlias(alias: str, actor: str='system') -> bool:
    """Delete an alias. Returns True if removed."""
    aliases = listAliases()
    before = next((a for a in aliases if a.get('alias') == alias), None)
    newAliases = [a for a in aliases if a.get('alias') != alias]
    if len(newAliases) == len(aliases):
        return False
    _writeAliases(newAliases)
    recordConfigAudit('alias', 'delete', actor, before=before, after=None)
    return True

def replaceAliases(aliases: list[AliasDict], actor: str='system') -> list[AliasDict]:
    """Replace the entire alias list. Validates each entry's provider first."""
    normalised: list[AliasDict] = []
    for entry in aliases:
        alias = (entry.get('alias') or '').strip()
        if not alias:
            raise ValueError("alias entry missing 'alias' field")
        targetModel = entry.get('targetModel') or entry.get('target_model') or ''
        targetProvider = entry.get('targetProvider') or entry.get('target_provider') or ''
        ok, msg = validateTarget(targetProvider, targetModel)
        if not ok:
            raise ValueError(f"Alias '{alias}': {msg}")
        normalised.append(AliasDict(alias=alias, targetModel=targetModel, targetProvider=targetProvider, **({'displayAlias': entry['displayAlias']} if entry.get('displayAlias') else {})))
    before = listAliases()
    _writeAliases(normalised)
    recordConfigAudit('alias', 'replace', actor, before=before, after=normalised)
    return normalised