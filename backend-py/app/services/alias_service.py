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

    **Case convention**

    In-memory :class:`AliasDict` uses snake_case (``target_model``, …).
    On-disk ``config.json`` and HTTP JSON to the UI keep camelCase
    (``targetModel``, …). Use :func:`alias_from_wire` / :func:`alias_to_wire`
    at those boundaries.
"""

from __future__ import annotations

from typing import cast

from app.atomic_write import write_json_atomic
from app.config import settings
from app.json_narrowing import as_dict, as_list, as_str
from app.lib.paths import dataPath
from app.services.memory_store import record_config_audit
from app.type_aliases import AliasDict, JsonValue


def alias_from_wire(raw: object) -> AliasDict:
    """Normalize a config/API alias entry (camelCase or snake_case) to AliasDict."""
    entry = as_dict(raw)
    out: AliasDict = {
        'alias': as_str(entry.get('alias')).strip(),
        'target_model': as_str(entry.get('target_model')) or as_str(entry.get('targetModel')) or '',
        'target_provider': as_str(entry.get('target_provider')) or as_str(entry.get('targetProvider')) or '',
    }
    display = as_str(entry.get('display_alias')) or as_str(entry.get('displayAlias')) or ''
    if display:
        out['display_alias'] = display
    return out


def alias_to_wire(entry: AliasDict | dict[str, object]) -> dict[str, object]:
    """Serialize an AliasDict to camelCase keys for config.json / HTTP responses."""
    d = cast(dict[str, object], entry)
    out: dict[str, object] = {
        'alias': as_str(d.get('alias')),
        'targetModel': as_str(d.get('target_model')) or as_str(d.get('targetModel')) or '',
        'targetProvider': as_str(d.get('target_provider')) or as_str(d.get('targetProvider')) or '',
    }
    display = as_str(d.get('display_alias')) or as_str(d.get('displayAlias')) or ''
    if display:
        out['displayAlias'] = display
    return out


def listAliases() -> list[AliasDict]:
    """Return all model-alias entries as snake_case AliasDict records."""
    import json

    p = dataPath('config.json')
    if not p.exists():
        return []
    try:
        cfg = json.loads(p.read_text('utf-8'))
    except (OSError, json.JSONDecodeError):
        return []
    aliases = as_list(cfg.get('modelAliases'), [])
    if not isinstance(aliases, list):
        return []
    return [alias_from_wire(a) for a in aliases if isinstance(a, dict)]


def listAliasesWire() -> list[dict[str, object]]:
    """Return aliases in camelCase wire form for HTTP / agent JSON responses."""
    return [alias_to_wire(a) for a in listAliases()]


def _writeAliases(aliases: list[AliasDict]) -> None:
    """Write the full aliases list to ``config.json`` atomically (camelCase keys)."""
    import json

    p = dataPath('config.json')
    cfg = json.loads(p.read_text('utf-8')) if p.exists() else {}
    cfg['modelAliases'] = [alias_to_wire(a) for a in aliases]
    write_json_atomic(p, cfg, indent=2)
    settings.reload()
    try:
        from app.services import model_service

        model_service.invalidate_cache()
    except Exception:
        pass


def _find(alias: str) -> AliasDict | None:
    for a in listAliases():
        if as_str(a.get('alias')) == alias:
            return a
    return None


def _providerNames() -> set[str]:
    """Provider names/ids from providers.json."""
    names: set[str] = set()
    try:
        from app.services import config_service

        store = config_service.getProvidersStore()
        for entry in as_list(store.get('providers'), []):
            e = as_dict(entry)
            names.add(as_str(e.get('name'), ''))
            names.add(as_str(e.get('id'), ''))
            for a in as_list(e.get('aliases'), []):
                names.add(as_str(a))
    except Exception:
        pass
    names.discard('')
    return names


def validateTarget(target_provider: str, target_model: str) -> tuple[bool, str]:
    """Validate alias targets (non-empty provider + model).

    Unknown provider names are allowed — there is no built-in template
    catalog; users configure providers themselves.
    """
    if not target_provider:
        return (False, 'target_provider is required')
    if not target_model:
        return (False, 'target_model is required')
    return (True, '')


def createAlias(
    alias: str, target_model: str, target_provider: str, actor: str = 'system', display_alias: str = ''
) -> AliasDict:
    """Create or upsert a model alias. Returns the stored entry (snake_case)."""
    alias = (alias or '').strip()
    if not alias:
        raise ValueError('alias is required')
    ok, msg = validateTarget(target_provider, target_model)
    if not ok:
        raise ValueError(msg)
    aliases = listAliases()
    entry: AliasDict = {'alias': alias, 'target_model': target_model, 'target_provider': target_provider}
    if display_alias:
        entry['display_alias'] = display_alias
    before = _find(alias)
    if before is not None:
        beforeCopy = dict(before)
        # Update in-place within the loaded list
        for i, a in enumerate(aliases):
            if as_str(a.get('alias')) == alias:
                merged = {**a, **entry}
                aliases[i] = cast(AliasDict, merged)
                entry = aliases[i]
                break
    else:
        beforeCopy = None
        aliases.append(entry)
    _writeAliases(aliases)
    record_config_audit(
        'alias',
        'create' if beforeCopy is None else 'upsert',
        actor,
        before=cast('JsonValue', alias_to_wire(beforeCopy) if beforeCopy else None),
        after=cast('JsonValue', alias_to_wire(entry)),
    )
    return entry


def update_alias(
    alias: str, target_model: str | None = None, target_provider: str | None = None, actor: str = 'system'
) -> AliasDict:
    """Update an existing alias. Returns the updated alias or raises if not found."""
    aliases = listAliases()
    existing = next((a for a in aliases if as_str(a.get('alias')) == alias), None)
    if existing is None:
        raise KeyError(f"Alias '{alias}' not found")
    before = dict(existing)
    newModel = target_model if target_model is not None else as_str(existing.get('target_model'), '')
    newProvider = target_provider if target_provider is not None else as_str(existing.get('target_provider'), '')
    ok, msg = validateTarget(newProvider, newModel)
    if not ok:
        raise ValueError(msg)
    if target_model is not None:
        existing['target_model'] = target_model
    if target_provider is not None:
        existing['target_provider'] = target_provider
    _writeAliases(aliases)
    record_config_audit(
        'alias',
        'update',
        actor,
        before=cast('JsonValue', alias_to_wire(before)),
        after=cast('JsonValue', alias_to_wire(existing)),
    )
    return existing


def delete_alias(alias: str, actor: str = 'system') -> bool:
    """Delete an alias. Returns True if removed."""
    aliases = listAliases()
    before = next((a for a in aliases if as_str(a.get('alias')) == alias), None)
    newAliases = [a for a in aliases if as_str(a.get('alias')) != alias]
    if len(newAliases) == len(aliases):
        return False
    _writeAliases(newAliases)
    record_config_audit(
        'alias',
        'delete',
        actor,
        before=cast('JsonValue', alias_to_wire(before) if before else None),
        after=None,
    )
    return True


def replaceAliases(aliases: list[AliasDict] | list[dict[str, object]], actor: str = 'system') -> list[AliasDict]:
    """Replace the entire alias list. Validates each entry's provider first.

    Accepts wire (camelCase) or internal (snake_case) entry dicts.
    """
    normalised: list[AliasDict] = []
    for raw in aliases:
        entry = alias_from_wire(raw)
        alias = as_str(entry.get('alias')).strip()
        if not alias:
            raise ValueError("alias entry missing 'alias' field")
        target_model = as_str(entry.get('target_model')) or ''
        target_provider = as_str(entry.get('target_provider')) or ''
        ok, msg = validateTarget(target_provider, target_model)
        if not ok:
            raise ValueError(f"Alias '{alias}': {msg}")
        entry['alias'] = alias
        normalised.append(entry)
    before = listAliases()
    _writeAliases(normalised)
    record_config_audit(
        'alias',
        'replace',
        actor,
        before=cast('JsonValue', [alias_to_wire(a) for a in before]),
        after=cast('JsonValue', [alias_to_wire(a) for a in normalised]),
    )
    return normalised
