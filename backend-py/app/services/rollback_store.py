"""Declarative rollback log for Observability / Settings Undo.

Entries live in ``config.json`` → ``rollbackLog``. File snapshots stay in
``checkpoint_service``; this store holds thin pointers (and config diffs)
so the UI can list and undo without duplicating file blobs.
"""

from __future__ import annotations

import copy
import json
import uuid
from datetime import datetime, timezone
from typing import Any, cast

from app.json_narrowing import as_dict, as_list, as_str
from app.services.config_service import getConfig, saveConfig
from app.type_aliases import JsonValue

MAX_ENTRIES = 100


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def list_entries() -> list[dict[str, object]]:
    cfg = getConfig()
    return [as_dict(x) for x in as_list(cfg.get('rollbackLog'))]


def get_entry(entry_id: str) -> dict[str, object] | None:
    eid = (entry_id or '').strip()
    if not eid:
        return None
    for item in list_entries():
        if as_str(item.get('id')) == eid:
            return item
    return None


def _persist(items: list[dict[str, object]]) -> None:
    cfg = getConfig()
    cfg['rollbackLog'] = items[-MAX_ENTRIES:]
    saveConfig(cfg)


def record_rollback(
    type: str,
    target: str,
    before: object = None,
    after: object = None,
    status: str = 'available',
    extra: dict[str, object] | None = None,
) -> dict[str, object]:
    """Append a rollback entry and return it."""
    entry: dict[str, object] = {
        'id': f'rb_{uuid.uuid4().hex[:10]}',
        'at': _now(),
        'type': type or 'unknown',
        'target': target or '',
        'before': before,
        'after': after,
        'status': status or 'available',
    }
    if extra:
        for k, v in extra.items():
            if k not in entry:
                entry[k] = v
    items = list_entries()
    items.append(entry)
    _persist(items)
    return entry


def _set_nested(cfg: dict[str, Any], key_path: str, value: object) -> None:
    keys = [k for k in key_path.split('.') if k]
    if not keys:
        return
    cur: dict[str, Any] = cfg
    for k in keys[:-1]:
        nxt = cur.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[k] = nxt
        cur = nxt
    cur[keys[-1]] = value


def _get_nested(cfg: dict[str, Any], key_path: str) -> object:
    keys = [k for k in key_path.split('.') if k]
    cur: object = cfg
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def undo_entry(entry_id: str) -> dict[str, object]:
    """Undo a rollback entry. Returns ``{ok, entry, message}``."""
    items = list_entries()
    entry: dict[str, object] | None = None
    idx = -1
    for i, item in enumerate(items):
        if as_str(item.get('id')) == entry_id:
            entry = item
            idx = i
            break
    if entry is None or idx < 0:
        return {'ok': False, 'entry': None, 'id': entry_id, 'message': 'No rollback entry'}

    status = as_str(entry.get('status') or 'available')
    if status != 'available':
        return {
            'ok': False,
            'entry': entry,
            'id': entry_id,
            'message': f'Entry is not available to undo (status={status})',
        }

    rtype = as_str(entry.get('type'))
    try:
        if rtype in ('restore_file', 'restore_checkpoint', 'checkpoint'):
            before_dict = as_dict(entry.get('before'))
            session_id = as_str(before_dict.get('sessionId')) or as_str(entry.get('sessionId'))
            checkpoint_id = (
                as_str(before_dict.get('checkpointId'))
                or as_str(before_dict.get('id'))
                or as_str(entry.get('checkpointId'))
            )
            if not session_id or not checkpoint_id:
                raise ValueError('Missing sessionId/checkpointId on rollback entry')
            from app.services.workbench.checkpoint_service import restore_checkpoint

            # No workspace is passed, so this falls back to the live session
            # and REFUSES when the session is not live — which is the correct
            # direction (a checkpoint manifest is not an authority) but it does
            # mean a rollback of a non-live session's checkpoint now fails
            # with `Cannot verify checkpoint containment`. That is a real
            # limitation, not an oversight: the rollback log does not record a
            # workspace, so there is nothing honest to pass. Recorded here so
            # the next reader does not go looking for a workspace field that
            # was promised in an earlier version of this comment and never
            # written.
            result = restore_checkpoint(session_id, checkpoint_id)
            if not result.get('ok'):
                raise ValueError(as_str(result.get('error')) or 'Checkpoint restore failed')
            message = as_str(result.get('message')) or 'Checkpoint restored'
        elif rtype in ('restore_setting',):
            key_path = as_str(entry.get('target'))
            if not key_path:
                raise ValueError('Missing settings keyPath on rollback entry')
            cfg = getConfig()
            _set_nested(cfg, key_path, copy.deepcopy(entry.get('before')))
            saveConfig(cfg)
            message = f'Restored setting {key_path}'
        elif rtype == 'restore_model_selection':
            before = entry.get('before')
            cfg = getConfig()
            if isinstance(before, dict):
                if 'activeModel' in before:
                    cfg['activeModel'] = before.get('activeModel')
                if 'activeProvider' in before:
                    cfg['activeProvider'] = before.get('activeProvider')
            else:
                key_path = as_str(entry.get('target')) or 'activeModel'
                _set_nested(cfg, key_path, copy.deepcopy(before))
            saveConfig(cfg)
            message = 'Restored model selection'
        elif rtype == 'restore_provider':
            from app.services.config_service import getProvidersStore, saveProvidersStore

            store = getProvidersStore()
            providers = [as_dict(p) for p in as_list(store.get('providers'))]
            target = as_str(entry.get('target'))
            before = entry.get('before')
            # Delete created (before was None) or restore prior blob / re-insert deleted.
            providers = [
                p
                for p in providers
                if str(p.get('id') or p.get('name')) != target
            ]
            if isinstance(before, dict):
                providers.append(copy.deepcopy(before))
            store['providers'] = providers
            saveProvidersStore(store)
            message = f'Restored provider {target}' if before is not None else f'Removed created provider {target}'
        elif rtype == 'restore_agent_config':
            cfg = getConfig()
            custom = [as_dict(a) for a in as_list(cfg.get('customAgents'))]
            target = as_str(entry.get('target'))
            before = entry.get('before')
            custom = [a for a in custom if str(a.get('id') or a.get('name')) != target]
            if isinstance(before, dict):
                custom.append(copy.deepcopy(before))
            cfg['customAgents'] = custom
            saveConfig(cfg)
            message = f'Restored agent {target}' if before is not None else f'Removed created agent {target}'
        elif rtype == 'restore_memory_item':
            from app.services import memory_store

            target = as_str(entry.get('target'))
            before = entry.get('before')
            if target.startswith('project:'):
                # Part 17 Phase A project delete: restore the md entry into
                # its workspace exactly as snapshotted (no global copy).
                try:
                    from app.services import project_memory as _pm

                    if isinstance(before, dict) and as_str(before.get('workspace')):
                        _targetFile = as_str(before.get('file') or '') or 'memory.md'
                        # per_fact is true when the snapshot recorded it, or —
                        # for snapshots taken before that field existed — when
                        # the entry did NOT live in the legacy single-file
                        # memory.md. Defaulting it to True instead turned a
                        # legacy entry into a per-fact file under a new slug on
                        # restore, so the undo changed the layout it was meant
                        # to undo.
                        _perFact = bool(before.get('perFact')) or _targetFile != 'memory.md'
                        _pm.upsert_entry(
                            as_str(before.get('workspace')),
                            as_str(before.get('title')) or target.removeprefix('project:'),
                            as_str(before.get('body') or ''),
                            file=_targetFile,
                            # Restore the frontmatter too. Without these the
                            # undo recreated a bare `## <title>` section,
                            # permanently downgrading the per-fact file to the
                            # legacy layout and losing its description/kind, so
                            # recall fell back to the full body text.
                            description=as_str(before.get('description') or ''),
                            kind=as_str(before.get('kind') or ''),
                            per_fact=_perFact,
                        )
                        message = f'Restored project memory {target}'
                    else:
                        # Raise so undo reports ok=False — a silent
                        # "message only" here returned ok=True with the
                        # entry still deleted.
                        raise ValueError(
                            f'Cannot restore project memory {target}: no workspace in snapshot'
                        )
                except Exception as exc:
                    # Must NOT be swallowed. The handler's whole purpose is to
                    # make undo report ok=False; catching here fell through to
                    # the success return below, so a failed restore reported
                    # ok=True, restored nothing, and still burned the entry as
                    # 'undone' — the user could not retry.
                    raise RuntimeError(f'Restore project memory {target} failed: {exc}') from exc
            elif before is None:
                memory_store.delete_fact(target)
                message = f'Deleted created memory {target}'
            elif isinstance(before, dict):
                # Wire shape from get_fact: factKey/factValue/category (or
                # key/value). Phase D hygiene: source/title/kind/expiresAt/
                # confidence ride along — a rollback must not silently
                # degrade the fact into an untitled default entry.
                key = as_str(before.get('factKey') or before.get('key') or target)
                # A fact value is stored JSON-encoded and get_fact does NOT
                # decode it (memory_store._row_as_wire only camelCases the
                # row). Handing that raw string straight back to save_fact —
                # which encodes again — added one JSON layer per Undo, so a
                # recalled fact came back wrapped in literal quote characters
                # and repeated undos compounded until the text was unreadable.
                # Decode exactly one layer, and leave an object verbatim:
                # unwrapping one would drop its members on the next save.
                raw_value = (
                    before.get('factValue') if 'factValue' in before else before.get('value')
                )
                value: object = raw_value
                if isinstance(raw_value, str):
                    try:
                        value = json.loads(raw_value)
                    except (json.JSONDecodeError, TypeError, ValueError):
                        value = raw_value
                category = as_str(before.get('category') or 'general') or 'general'
                # Restore the row to the home it was born in — a
                # bot-scoped fact resurrected without its scope leaked into
                # the global store. The snapshot IS the source of truth, so
                # the restore is allowed across scopes.
                rowScope = as_str(before.get('scope') or 'global')
                try:
                    memory_store.save_fact(
                        key,
                        cast(JsonValue, value),
                        category=category,
                        source=as_str(before.get('source') or ''),
                        confidence=float(before.get('confidence') or 1.0),
                        expires_at=as_str(before.get('expiresAt') or '') or None,
                        title=as_str(before.get('title') or ''),
                        kind=as_str(before.get('kind') or ''),
                        scope=rowScope,
                        allow_scope_override=True,
                    )
                except (TypeError, ValueError):
                    memory_store.save_fact(
                        key,
                        cast(JsonValue, value),
                        category=category,
                        scope=rowScope,
                        allow_scope_override=True,
                    )
                message = f'Restored memory {key}'
            else:
                memory_store.save_fact(
                    target,
                    cast(JsonValue, before),
                    category='general',
                    allow_scope_override=True,
                )
                message = f'Restored memory {target}'
        else:
            # Generic: if target looks like a dotted config path, restore before.
            key_path = as_str(entry.get('target'))
            if '.' in key_path or key_path in ('activeModel', 'activeProvider'):
                cfg = getConfig()
                _set_nested(cfg, key_path, copy.deepcopy(entry.get('before')))
                saveConfig(cfg)
                message = f'Restored {key_path}'
            else:
                raise ValueError(f'Unsupported rollback type: {rtype or "unknown"}')

        entry = dict(entry)
        entry['status'] = 'undone'
        entry['undoneAt'] = _now()
        items[idx] = entry
        _persist(items)
        return {'ok': True, 'entry': entry, 'id': entry_id, 'message': message}
    except Exception as exc:
        entry = dict(entry)
        entry['status'] = 'failed'
        entry['error'] = str(exc)
        entry['failedAt'] = _now()
        items[idx] = entry
        _persist(items)
        return {'ok': False, 'entry': entry, 'id': entry_id, 'message': str(exc)}


def capture_setting_before(key_path: str) -> object:
    """Read current nested config value for a settings keyPath."""
    if not key_path:
        return None
    return copy.deepcopy(_get_nested(getConfig(), key_path))
