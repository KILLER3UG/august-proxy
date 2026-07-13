"""
Alias service — single source of truth for model-alias CRUD.

Shared by the agent-callable alias tools and the HTTP routes (``/api/manage``
and ``/api/config/model-aliases``). Centralises read/write of the
``config.json`` ``modelAliases`` list, adds provider+model validation, reloads
settings so resolvers see changes immediately, invalidates the model cache so
the dropdown refreshes, and records every change to the config audit log.

.. note::

    **CRUD vs. Resolution**

    This module handles **CRUD** (create, read, update, delete) of alias
    entries in ``config.json``. For **resolution** (turning an alias into
    a concrete provider + model at request time), use
    ``app.services.aliasMappingService.resolve_alias()`` instead.

    An alias in August Proxy is a **proxy mapping** — it lets the proxy
    display one model name (the alias) while routing to a completely
    different provider + model combination upstream. See
    ``app.models.aliases`` for the conceptual model.
"""

from __future__ import annotations
from typing import cast

from app.config import settings
from app.lib.paths import dataPath
from app.services.memory_store import record_config_audit
from app.typeAliases import AliasDict, JsonValue
from app.json_narrowing import as_dict, as_list, as_str
from app.atomic_write import write_json_atomic


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
    aliases = as_list(cfg.get('modelAliases'), [])
    return cast('list[AliasDict]', aliases) if isinstance(aliases, list) else []


def _writeAliases(aliases: list[AliasDict]) -> None:
    """Write the full aliases list to ``config.json`` atomically."""
    import json

    p = dataPath('config.json')
    cfg = json.loads(p.read_text('utf-8')) if p.exists() else {}
    cfg['modelAliases'] = aliases
    write_json_atomic(p, cfg, indent=2)
    settings.reload()
    try:
        from app.services import model_service

        model_service.invalidateCache()
    except Exception:
        pass


def _find(alias: str) -> AliasDict | None:
    for a in listAliases():
        if as_str(a.get('alias')) == alias:
            return a
    return None


def _providerNames() -> set[str]:
    """All known provider names + aliases (templates and custom)."""
    names: set[str] = set()
    try:
        from app.providers.template_loader import getTemplates

        for t in getTemplates():
            names.add(as_str(t.get('name'), ''))
            for a in as_list(t.get('aliases'), []):
                names.add(as_str(a))
        from app.services import config_service

        store = config_service.getProvidersStore()
        for entry in as_list(store.get('providers'), []):
            names.add(as_str(as_dict(entry).get('name'), ''))
    except Exception:
        pass
    names.discard('')
    return names


def validateTarget(target_provider: str, target_model: str) -> tuple[bool, str]:
    """Validate that provider (strict) and model (loose) are plausible.

    Returns ``(ok, message)``. An unknown provider is a hard error; an
    unknown model is a soft warning (it may still be valid upstream).
    """
    if not target_provider:
        return (False, 'target_provider is required')
    if target_provider not in _providerNames():
        return (False, f"Unknown provider '{target_provider}'")
    if not target_model:
        return (False, 'target_model is required')
    return (True, '')


def createAlias(
    alias: str, target_model: str, target_provider: str, actor: str = 'system', display_alias: str = ''
) -> AliasDict:
    """Create or upsert a model alias. Returns the stored entry."""
    alias = (alias or '').strip()
    if not alias:
        raise ValueError('alias is required')
    ok, msg = validateTarget(target_provider, target_model)
    if not ok:
        raise ValueError(msg)
    aliases = listAliases()
    entry: AliasDict = {'alias': alias, 'targetModel': target_model, 'targetProvider': target_provider}
    if display_alias:
        entry['displayAlias'] = display_alias
    before = _find(alias)
    if before is not None:
        beforeCopy = dict(before)
        before.update(entry)
        entry = before
    else:
        beforeCopy = None
        aliases.append(entry)
    _writeAliases(aliases)
    record_config_audit(
        'alias',
        'create' if beforeCopy is None else 'upsert',
        actor,
        before=cast('JsonValue', beforeCopy),
        after=cast('JsonValue', entry),
    )
    return entry


def update_alias(
    alias: str, target_model: str | None = None, target_provider: str | None = None, actor: str = 'system'
) -> AliasDict:
    """Update an existing alias. Returns the updated alias or None if not found."""
    aliases = listAliases()
    existing = next((a for a in aliases if as_str(a.get('alias')) == alias), None)
    if existing is None:
        raise KeyError(f"Alias '{alias}' not found")
    before = dict(existing)
    newModel = target_model if target_model is not None else as_str(existing.get('targetModel'), '')
    newProvider = target_provider if target_provider is not None else as_str(existing.get('targetProvider'), '')
    ok, msg = validateTarget(newProvider, newModel)
    if not ok:
        raise ValueError(msg)
    if target_model is not None:
        existing['targetModel'] = target_model
    if target_provider is not None:
        existing['targetProvider'] = target_provider
    _writeAliases(aliases)
    record_config_audit('alias', 'update', actor, before=cast('JsonValue', before), after=cast('JsonValue', existing))
    return existing


def delete_alias(alias: str, actor: str = 'system') -> bool:
    """Delete an alias. Returns True if removed."""
    aliases = listAliases()
    before = next((a for a in aliases if as_str(a.get('alias')) == alias), None)
    newAliases = [a for a in aliases if as_str(a.get('alias')) != alias]
    if len(newAliases) == len(aliases):
        return False
    _writeAliases(newAliases)
    record_config_audit('alias', 'delete', actor, before=cast('JsonValue', before), after=None)
    return True


def replaceAliases(aliases: list[AliasDict], actor: str = 'system') -> list[AliasDict]:
    """Replace the entire alias list. Validates each entry's provider first."""
    normalised: list[AliasDict] = []
    for entry in aliases:
        alias = as_str(entry.get('alias')).strip()
        if not alias:
            raise ValueError("alias entry missing 'alias' field")
        target_model = as_str(entry.get('targetModel')) or as_str(entry.get('target_model')) or ''
        target_provider = as_str(entry.get('targetProvider')) or as_str(entry.get('target_provider')) or ''
        ok, msg = validateTarget(target_provider, target_model)
        if not ok:
            raise ValueError(f"Alias '{alias}': {msg}")
        normalised.append(
            AliasDict(
                alias=alias,
                targetModel=target_model,
                targetProvider=target_provider,
                **{'displayAlias': entry['displayAlias']} if as_str(entry.get('displayAlias')) else {},
            )
        )
    before = listAliases()
    _writeAliases(normalised)
    record_config_audit('alias', 'replace', actor, before=cast('JsonValue', before), after=cast('JsonValue', normalised))
    return normalised