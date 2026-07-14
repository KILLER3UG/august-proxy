"""Start optional cognitive background services during app lifespan.

Controlled by the single ``auxiliary.cognitive`` tree
(see ``cognitive_config``). Defaults favour keeping data planes warm
without requiring a perfect config.

Services
--------
* **db_writer** queue worker
* **cron scheduler** (scheduled-jobs.json)
* **consolidation** sleep-cycle loop (one path only: Cognitive Scheduler)
* **workbench→brain backfill** on startup
* **environment_watcher** only when enabled (session-scoped attach)
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger('cognitive_boot')

_tasks: list[asyncio.Task] = []
_cognitive_scheduler: Any = None
_status: dict[str, Any] = {
    'started': False,
    'services': {},
    'errors': [],
}
_consolidation_lock = asyncio.Lock()
_session_watchers: dict[str, object] = {}


def get_boot_status() -> dict[str, object]:
    return {
        'started': bool(_status.get('started')),
        'services': dict(_status.get('services') or {}),
        'errors': list(_status.get('errors') or []),
        'session_watchers': list(_session_watchers.keys()),
    }


def get_cognitive_scheduler() -> Any:
    """Return the in-process cognitive Scheduler (or None if not started)."""
    return _cognitive_scheduler


def record_user_activity(session_id: str = '') -> None:
    """Reset idle timer on the cognitive scheduler (called from workbench turns)."""
    sched = _cognitive_scheduler
    if sched is not None and hasattr(sched, 'recordActivity'):
        try:
            sched.recordActivity(session_id or 'default')
        except Exception:
            logger.debug('record_user_activity failed', exc_info=True)


async def run_consolidation_once() -> dict[str, object]:
    """Run consolidation with a process-wide mutex (interval + idle share this)."""
    async with _consolidation_lock:
        from app.services.consolidation_daemon import runConsolidation

        return await runConsolidation()


async def start_cognitive_services(app: object | None = None) -> dict[str, object]:
    """Start background cognitive services. Idempotent."""
    global _cognitive_scheduler
    if _status.get('started'):
        return get_boot_status()

    from app.services.cognitive_config import ensure_defaults, get_boot_layers, get_consolidation_interval_s

    ensure_defaults()
    layers = get_boot_layers()
    services: dict[str, object] = {}
    errors: list[str] = []

    # 1) Workbench JSON → brain backfill (sync, fast for typical session counts)
    if layers.get('backfill_workbench'):
        try:
            from app.services.workbench.brain_sync import backfill_workbench_json_to_brain

            result = backfill_workbench_json_to_brain()
            services['backfill_workbench'] = result
        except Exception as exc:
            logger.exception('workbench backfill failed')
            errors.append(f'backfill: {exc}')
            services['backfill_workbench'] = {'ok': False, 'error': str(exc)}
    else:
        services['backfill_workbench'] = {'skipped': True}

    # 2) DB writer queue
    if layers.get('db_writer'):
        try:
            from app.services.db_writer import ensure_queue

            ensure_queue()
            services['db_writer'] = {'ok': True}
        except Exception as exc:
            logger.exception('db_writer ensure_queue failed')
            errors.append(f'db_writer: {exc}')
            services['db_writer'] = {'ok': False, 'error': str(exc)}
    else:
        services['db_writer'] = {'skipped': True}

    # 3) Cron job scheduler (scheduled-jobs.json) — separate from cognitive idle/interval
    if layers.get('cron_scheduler'):
        try:
            from app.services.scheduler import startScheduler

            t = asyncio.create_task(startScheduler(60), name='cron_scheduler')
            _tasks.append(t)
            services['cron_scheduler'] = {'ok': True}
        except Exception as exc:
            logger.exception('cron scheduler start failed')
            errors.append(f'cron_scheduler: {exc}')
            services['cron_scheduler'] = {'ok': False, 'error': str(exc)}
    else:
        services['cron_scheduler'] = {'skipped': True}

    # 4) One Cognitive Scheduler: interval consolidation + idle hook (mutex-deduped)
    try:
        from app.services.scheduler import Scheduler
        import os

        _cognitive_scheduler = Scheduler()
        if layers.get('consolidation'):
            interval = get_consolidation_interval_s()

            async def _interval_consolidate() -> None:
                await run_consolidation_once()

            # Prefer scheduler interval registration when available; else task.
            if hasattr(_cognitive_scheduler, 'registerInterval'):
                _cognitive_scheduler.registerInterval('consolidation', _interval_consolidate, interval)
            else:
                async def _consolidation_loop() -> None:
                    if os.environ.get('AUGUST_CONSOLIDATION_RUN_ON_BOOT', '').strip() in ('1', 'true', 'yes'):
                        try:
                            await run_consolidation_once()
                        except Exception:
                            logger.exception('consolidation on-boot run failed')
                    while True:
                        try:
                            await asyncio.sleep(interval)
                            await run_consolidation_once()
                        except asyncio.CancelledError:
                            raise
                        except Exception:
                            logger.exception('consolidation loop iteration failed')

                t = asyncio.create_task(_consolidation_loop(), name='consolidation_loop')
                _tasks.append(t)

            async def _idle_consolidate() -> None:
                await run_consolidation_once()

            idle_s = float(os.environ.get('AUGUST_CONSOLIDATION_IDLE_S', '1800'))
            _cognitive_scheduler.registerIdle('consolidation_idle', _idle_consolidate, idle_s)
            services['consolidation'] = {'ok': True, 'interval_s': interval, 'idle_s': idle_s}
        else:
            services['consolidation'] = {'skipped': True}

        await _cognitive_scheduler.start()
        services['cognitive_scheduler'] = {'ok': True}
        if app is not None and hasattr(app, 'state'):
            app.state.cognitive_scheduler = _cognitive_scheduler  # type: ignore[attr-defined]
    except Exception as exc:
        logger.exception('cognitive Scheduler start failed')
        errors.append(f'cognitive_scheduler: {exc}')
        services['cognitive_scheduler'] = {'ok': False, 'error': str(exc)}
        if 'consolidation' not in services:
            services['consolidation'] = {'ok': False, 'error': str(exc)}

    # 5) Environment watcher — session attach when workspacePath is set
    if layers.get('environment_watcher'):
        services['environment_watcher'] = {
            'ok': True,
            'note': 'enabled; attach via attach_session_watcher(session_id, workspace_path)',
        }
    else:
        services['environment_watcher'] = {'skipped': True}

    # Ensure daemon manager singleton exists
    try:
        from app.services.daemon_manager import getManager

        getManager()
        services['daemon_manager'] = {'ok': True}
    except Exception as exc:
        errors.append(f'daemon_manager: {exc}')
        services['daemon_manager'] = {'ok': False, 'error': str(exc)}

    # MCP: load durable config and auto-start enabled servers
    try:
        from app.services.tools.mcp_client import load_and_start_from_config

        mcp_status = await load_and_start_from_config()
        services['mcp'] = mcp_status
    except Exception as exc:
        logger.exception('MCP boot load failed')
        errors.append(f'mcp: {exc}')
        services['mcp'] = {'ok': False, 'error': str(exc)}

    _status['started'] = True
    _status['services'] = services
    _status['errors'] = errors
    if app is not None and hasattr(app, 'state'):
        app.state.cognitive_boot = get_boot_status()  # type: ignore[attr-defined]
    logger.info('Cognitive boot complete: %s', {k: v for k, v in services.items()})
    return get_boot_status()


def attach_session_watcher(session_id: str, workspace_path: str) -> dict[str, object]:
    """Start a session-scoped environment watcher and log events to SQLite.

    No-op when environment_watcher boot flag is off or path is empty.
    """
    from app.services.cognitive_config import get_boot_layers

    layers = get_boot_layers()
    if not layers.get('environment_watcher'):
        return {'ok': False, 'skipped': True, 'reason': 'environment_watcher disabled'}
    if not session_id or not workspace_path:
        return {'ok': False, 'skipped': True, 'reason': 'missing session_id or workspace_path'}
    if session_id in _session_watchers:
        return {'ok': True, 'already': True, 'session_id': session_id}

    try:
        from app.services.environment_watcher import EnvironmentWatcher, recordChange
        from app.services.brain_write_facade import save_kv
        import time

        def _on_event(e: object) -> None:
            path = getattr(e, 'path', '')
            kind = getattr(e, 'kind', 'change')
            ts = float(getattr(e, 'timestamp', time.time()))
            source = getattr(e, 'source', 'watcher')
            change = {'path': path, 'kind': kind, 'timestamp': ts, 'source': source}
            recordChange(session_id, change)
            try:
                # Append-only log keyed by session (last 100 events).
                from app.services.memory_store import get_memory

                key = f'env_events:{session_id}'
                existing = get_memory(key)
                events = existing if isinstance(existing, list) else []
                events = list(events)[-99:] + [change]
                save_kv(key, events)
            except Exception:
                logger.debug('env event SQLite log failed', exc_info=True)

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
    """Cancel background tasks started by ``start_cognitive_services``."""
    global _cognitive_scheduler
    for sid in list(_session_watchers.keys()):
        detach_session_watcher(sid)
    for t in list(_tasks):
        t.cancel()
    for t in list(_tasks):
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    _tasks.clear()

    try:
        from app.services.scheduler import stopScheduler

        stopScheduler()
    except Exception:
        pass

    if _cognitive_scheduler is not None:
        try:
            await _cognitive_scheduler.stop()
        except Exception:
            pass
        _cognitive_scheduler = None

    try:
        from app.services.db_writer import shutdown as db_shutdown

        await db_shutdown()
    except Exception:
        pass

    try:
        from app.services.tools.mcp_client import stop_all_servers

        await stop_all_servers()
    except Exception:
        pass

    _status['started'] = False
    logger.info('Cognitive services stopped')
