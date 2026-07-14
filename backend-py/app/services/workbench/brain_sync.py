"""Workbench → SQLite helpers (backfill and health stats).

Normal chat turns should call ``save_sessions()``, which writes the full
session blob and messages in SQLite. This module remains for:

* Explicit backfill from residual JSON exports
* Health stats for operators
* Call sites that still import ``sync_workbench_session_to_brain``
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.services.workbench.sessions import WorkbenchSession

logger = logging.getLogger('workbench.brain_sync')

_DEFAULT_RETRIES = 3
_BACKOFF_S = (0.05, 0.15, 0.4)

# Process-level status for health / smoke scripts
_stats: dict[str, Any] = {
    'last_ok_at': None,
    'last_error_at': None,
    'last_error': None,
    'last_session_id': None,
    'success_count': 0,
    'failure_count': 0,
    'backfill_last': None,
}


def get_sync_stats() -> dict[str, object]:
    """Snapshot of brain sync health counters."""
    return dict(_stats)


def _strict_default() -> bool:
    return os.environ.get('AUGUST_BRAIN_SYNC_STRICT', '').strip() in ('1', 'true', 'yes')


def _sync_once(session: WorkbenchSession) -> None:
    """Single attempt: upsert session + replace messages + timeline breadcrumb."""
    from app.services.memory_store import (
        save_session,
        delete_session_messages,
        save_message,
        write_timeline_event,
    )

    save_session(
        {
            'id': session.id,
            'title': session.title or 'Workbench session',
            'startedAt': session.startedAt or session.createdAt or '',
            'messageCount': len(session.messages) if session.messages else session.messageCount,
            'provider': session.provider or '',
            'model': session.model or '',
            'folderId': None,
            'isArchived': False,
            'workspacePath': session.workspacePath or '',
        }
    )
    delete_session_messages(session.id)
    for msg in session.messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get('role') or 'user')
        content = msg.get('content', '')
        if msg.get('tool_calls') is not None or msg.get('tool_use_id') is not None:
            payload: object = {
                'content': content,
                **{k: msg[k] for k in ('tool_calls', 'tool_use_id', 'name') if k in msg},
            }
        else:
            payload = content
        save_message(session.id, role, payload)

    last_user = ''
    for m in reversed(session.messages or []):
        if isinstance(m, dict) and m.get('role') == 'user':
            c = m.get('content', '')
            last_user = c if isinstance(c, str) else str(c)
            break
    if last_user:
        summary = last_user.strip().replace('\n', ' ')[:240]
        if summary:
            write_timeline_event(session.id, summary, category='workbench')


def _mark_session_meta(session: WorkbenchSession, ok: bool, error: str | None = None) -> None:
    try:
        if not isinstance(session.metadata, dict):
            session.metadata = {}
        session.metadata['brainSyncOk'] = ok
        session.metadata['brainSyncAt'] = time.time()
        if error:
            session.metadata['brainSyncError'] = error[:500]
        else:
            session.metadata.pop('brainSyncError', None)
    except Exception:
        pass


def _emit_failure(session_id: str, error: str) -> None:
    try:
        from app.services.feature_flow import emit_feature_flow

        emit_feature_flow(
            feature='memory',
            stage='brain_sync',
            summary=f'Brain session sync failed for {session_id}',
            status='error',
            error=error[:200],
            meta={'sessionId': session_id},
        )
    except Exception:
        pass


def sync_workbench_session_to_brain(
    session: WorkbenchSession,
    *,
    retries: int | None = None,
    strict: bool | None = None,
) -> bool:
    """Upsert session row + replace messages for ``session.id`` in the brain DB.

    Returns True on success. Retries on failure. When ``strict`` is True
    (or env AUGUST_BRAIN_SYNC_STRICT=1), re-raises after exhausting retries.
    """
    attempts = retries if retries is not None else _DEFAULT_RETRIES
    attempts = max(1, int(attempts))
    is_strict = _strict_default() if strict is None else bool(strict)
    last_exc: BaseException | None = None
    sid = getattr(session, 'id', '?')

    for i in range(attempts):
        try:
            _sync_once(session)
            _stats['last_ok_at'] = time.time()
            _stats['last_session_id'] = sid
            _stats['success_count'] = int(_stats.get('success_count') or 0) + 1
            _stats['last_error'] = None
            _mark_session_meta(session, True)
            return True
        except Exception as exc:
            last_exc = exc
            logger.warning(
                'brain session sync attempt %d/%d failed for %s: %s',
                i + 1,
                attempts,
                sid,
                exc,
            )
            if i + 1 < attempts:
                delay = _BACKOFF_S[min(i, len(_BACKOFF_S) - 1)]
                time.sleep(delay)

    err = str(last_exc) if last_exc else 'unknown brain session sync failure'
    _stats['last_error_at'] = time.time()
    _stats['last_error'] = err
    _stats['last_session_id'] = sid
    _stats['failure_count'] = int(_stats.get('failure_count') or 0) + 1
    _mark_session_meta(session, False, err)
    _emit_failure(str(sid), err)
    logger.error('brain session sync exhausted retries for %s: %s', sid, err)

    if is_strict and last_exc is not None:
        raise last_exc
    return False


def backfill_workbench_json_to_brain(
    *,
    sessions_path: Path | None = None,
    max_sessions: int = 500,
) -> dict[str, object]:
    """One-shot / startup: copy workbench-sessions.json into brain SQLite.

    Idempotent per session id (messages are replaced). Does not remove brain
    sessions that no longer exist in JSON.
    """
    from app.lib.paths import dataPath
    from app.services.workbench.sessions import WorkbenchSession

    path = sessions_path or dataPath('workbench-sessions.json')
    result: dict[str, object] = {
        'path': str(path),
        'found': 0,
        'synced': 0,
        'failed': 0,
        'errors': [],
    }
    if not path.exists():
        result['message'] = 'no workbench-sessions.json'
        _stats['backfill_last'] = result
        return result

    try:
        raw = json.loads(path.read_text('utf-8'))
    except (json.JSONDecodeError, OSError) as exc:
        result['message'] = f'read failed: {exc}'
        _stats['backfill_last'] = result
        return result

    if not isinstance(raw, list):
        result['message'] = 'invalid JSON shape (expected list)'
        _stats['backfill_last'] = result
        return result

    items = raw[: max(0, int(max_sessions))]
    result['found'] = len(items)
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            session = WorkbenchSession.fromDict(item)
            if not session.id:
                continue
            ok = sync_workbench_session_to_brain(session, retries=2, strict=False)
            if ok:
                result['synced'] = int(result['synced']) + 1  # type: ignore[arg-type]
            else:
                result['failed'] = int(result['failed']) + 1  # type: ignore[arg-type]
                errors = result['errors']
                if isinstance(errors, list):
                    errors.append({'id': session.id, 'error': _stats.get('last_error')})
        except Exception as exc:
            result['failed'] = int(result['failed']) + 1  # type: ignore[arg-type]
            errors = result['errors']
            if isinstance(errors, list):
                errors.append({'id': item.get('id'), 'error': str(exc)})

    result['message'] = 'ok'
    _stats['backfill_last'] = result
    logger.info(
        'workbench→brain backfill: found=%s synced=%s failed=%s',
        result['found'],
        result['synced'],
        result['failed'],
    )
    return result
