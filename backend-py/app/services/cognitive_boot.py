"""Lean background boot: cron scheduler + daemon manager + session watchers.

The memory/consolidation/backfill layers were removed with the memory
system; this module keeps the runtime orchestration pieces the rest of
the app relies on.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger('august.cognitive_boot')

_tasks: list[asyncio.Task] = []
_session_watchers: dict[str, Any] = {}
_cognitive_scheduler: Any = None
_status: dict[str, Any] = {
    'started': False,
    'services': {},
    'errors': [],
}


def get_boot_status() -> dict[str, object]:
    return {
        'started': bool(_status.get('started')),
        'services': dict(_status.get('services') or {}),
        'errors': list(_status.get('errors') or []),
    }


def get_cognitive_scheduler() -> Any:
    return _cognitive_scheduler


def record_user_activity(session_id: str = '') -> None:
    """Best-effort activity tick for the session timeline."""
    if not session_id:
        return
    try:
        from app.services.memory_store.rest import write_timeline_event

        write_timeline_event(session_id, 'user activity', 'activity')
    except Exception:
        logger.debug('record_user_activity failed', exc_info=True)


async def start_cognitive_services(app: object | None = None) -> dict[str, object]:
    """Start background runtime services. Idempotent."""
    if _status.get('started'):
        return get_boot_status()

    services: dict[str, object] = {}
    errors: list[str] = []

    # Cron job scheduler (scheduled-jobs.json)
    try:
        from app.services.scheduler import startScheduler

        t = asyncio.create_task(startScheduler(60), name='cron_scheduler')
        _tasks.append(t)
        services['cron_scheduler'] = {'ok': True}
    except Exception as exc:
        logger.exception('cron scheduler start failed')
        errors.append(f'cron_scheduler: {exc}')
        services['cron_scheduler'] = {'ok': False, 'error': str(exc)}

    # Daemon manager singleton (rehydrate from DB)
    try:
        from app.services.daemon_manager import getManager

        mgr = getManager()
        try:
            n = mgr.rehydrate_from_db()
            if n:
                logger.info('Daemon rehydrate: %d daemons restored', n)
        except Exception:
            pass
        services['daemon_manager'] = {'ok': True}
    except Exception as exc2:
        errors.append(f'daemon_manager: {exc2}')
        services['daemon_manager'] = {'ok': False, 'error': str(exc2)}

    _status['started'] = True
    _status['services'] = services
    _status['errors'] = errors
    if app is not None and hasattr(app, 'state'):
        app.state.cognitive_boot = get_boot_status()  # type: ignore[attr-defined]
    return get_boot_status()


def attach_session_watcher(session_id: str, workspace_path: str) -> dict[str, object]:
    """Start a session-scoped environment watcher. No-op without a path."""
    if not session_id or not workspace_path:
        return {'ok': False, 'skipped': True, 'reason': 'missing session_id or workspace_path'}
    if session_id in _session_watchers:
        return {'ok': True, 'already': True, 'session_id': session_id}
    try:
        from app.services.environment_watcher import EnvironmentWatcher, recordChange

        def _on_event(e: object) -> None:
            path = getattr(e, 'path', '')
            kind = getattr(e, 'kind', 'change')
            source = getattr(e, 'source', 'watcher')
            recordChange(session_id, {'path': path, 'kind': kind, 'source': source})

        watcher = EnvironmentWatcher()
        if hasattr(watcher, 'subscribe'):
            watcher.subscribe(_on_event)
        if hasattr(watcher, 'start'):
            watcher.start(workspace_path)
        _session_watchers[session_id] = watcher
        return {'ok': True, 'session_id': session_id, 'workspace_path': workspace_path}
    except Exception as exc:
        logger.warning('attach_session_watcher failed: %s', exc)
        return {'ok': False, 'error': str(exc)}


def detach_session_watcher(session_id: str) -> None:
    w = _session_watchers.pop(session_id, None)
    if w is not None and hasattr(w, 'stop'):
        try:
            w.stop()  # type: ignore[operator]
        except Exception:
            pass


async def stop_cognitive_services() -> None:
    for t in list(_tasks):
        if not t.done():
            t.cancel()
    _tasks.clear()
    for sid in list(_session_watchers):
        detach_session_watcher(sid)
    _status['started'] = False
