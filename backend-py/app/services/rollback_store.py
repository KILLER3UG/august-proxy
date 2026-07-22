"""Declarative rollback log for Observability / Settings Undo.

Entries live in ``config.json`` → ``rollbackLog``. File snapshots stay in
``checkpoint_service``; this store holds thin pointers (and config diffs)
so the UI can list and undo without duplicating file blobs.
"""

from __future__ import annotations

import copy
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
    *,
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
            before = as_dict(entry.get('before'))
            session_id = as_str(before.get('sessionId')) or as_str(entry.get('sessionId'))
            checkpoint_id = (
                as_str(before.get('checkpointId'))
                or as_str(before.get('id'))
                or as_str(entry.get('checkpointId'))
            )
            if not session_id or not checkpoint_id:
                raise ValueError('Missing sessionId/checkpointId on rollback entry')
            from app.services.workbench.checkpoint_service import restore_checkpoint

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
            if before is None:
                memory_store.delete_fact(target)
                message = f'Deleted created memory {target}'
            elif isinstance(before, dict):
                # Wire shape from get_fact: factKey/factValue/category (or key/value)
                key = as_str(before.get('factKey') or before.get('key') or target)
                value = before.get('factValue') if 'factValue' in before else before.get('value')
                category = as_str(before.get('category') or 'general') or 'general'
                memory_store.save_fact(key, cast(JsonValue, value), category=category)
                message = f'Restored memory {key}'
            else:
                memory_store.save_fact(target, cast(JsonValue, before), category='general')
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
