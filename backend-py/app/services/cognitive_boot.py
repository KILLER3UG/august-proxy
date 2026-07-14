"""Start optional cognitive background services during app lifespan.

Controlled by ``config.json → auxiliary.cognitive_layers`` (and env overrides).
Defaults favour keeping data planes warm without requiring a perfect config.

Services
--------
* **db_writer** queue worker
* **cron scheduler** (scheduled-jobs.json)
* **consolidation** sleep-cycle loop (interval, default 24h)
* **workbench→brain backfill** on startup
* **environment_watcher** only when explicitly enabled (needs a root path)
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

logger = logging.getLogger('cognitive_boot')

_tasks: list[asyncio.Task] = []
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


def _layers() -> dict[str, bool]:
    """Resolve which cognitive services to start."""
    # Env master switch: AUGUST_COGNITIVE_BOOT=0 disables everything optional.
    master = os.environ.get('AUGUST_COGNITIVE_BOOT', '1').strip().lower()
    if master in ('0', 'false', 'no', 'off'):
        return {
            'db_writer': False,
            'cron_scheduler': False,
            'consolidation': False,
            'backfill_workbench': False,
            'environment_watcher': False,
        }

    cfg_layers: dict[str, object] = {}
    try:
        from app.config import settings

        aux = settings.config.get('auxiliary') if isinstance(settings.config, dict) else {}
        if isinstance(aux, dict):
            raw = aux.get('cognitive_layers')
            if isinstance(raw, dict):
                cfg_layers = raw
    except Exception:
        pass

    def flag(name: str, default: bool) -> bool:
        env_key = f'AUGUST_LAYER_{name.upper()}'
        if env_key in os.environ:
            return os.environ[env_key].strip().lower() in ('1', 'true', 'yes', 'on')
        val = cfg_layers.get(name)
        if isinstance(val, bool):
            return val
        return default

    return {
        # Lightweight / safe defaults ON so gaps stay closed without config.
        'db_writer': flag('db_writer', True),
        'cron_scheduler': flag('scheduler', True) or flag('cron_scheduler', True),
        'consolidation': flag('consolidation', True) or flag('sleep_cycle', True),
        'backfill_workbench': flag('backfill_workbench', True),
        'environment_watcher': flag('environment_watcher', False),
    }


def _consolidation_interval_s() -> float:
    env = os.environ.get('AUGUST_CONSOLIDATION_INTERVAL_S')
    if env:
        try:
            return max(60.0, float(env))
        except ValueError:
            pass
    try:
        from app.config import settings

        aux = settings.config.get('auxiliary') if isinstance(settings.config, dict) else {}
        if isinstance(aux, dict):
            raw = aux.get('consolidationIntervalS') or aux.get('consolidation_interval_s')
            if raw is not None:
                return max(60.0, float(raw))
    except Exception:
        pass
    return 86400.0  # 24h


async def _consolidation_loop(interval_s: float) -> None:
    from app.services.consolidation_daemon import runConsolidation

    logger.info('Consolidation loop started (interval=%.0fs)', interval_s)
    # First run deferred by interval so startup stays fast; set
    # AUGUST_CONSOLIDATION_RUN_ON_BOOT=1 to fire once immediately.
    if os.environ.get('AUGUST_CONSOLIDATION_RUN_ON_BOOT', '').strip() in ('1', 'true', 'yes'):
        try:
            await runConsolidation()
        except Exception:
            logger.exception('consolidation on-boot run failed')
    while True:
        try:
            await asyncio.sleep(interval_s)
            await runConsolidation()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception('consolidation loop iteration failed')


async def start_cognitive_services(app: object | None = None) -> dict[str, object]:
    """Start background cognitive services. Idempotent."""
    global _cognitive_scheduler
    if _status.get('started'):
        return get_boot_status()

    layers = _layers()
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

    # 3) Cron job scheduler (scheduled-jobs.json)
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

    # 4) Consolidation sleep cycle
    if layers.get('consolidation'):
        try:
            interval = _consolidation_interval_s()
            t = asyncio.create_task(_consolidation_loop(interval), name='consolidation_loop')
            _tasks.append(t)
            services['consolidation'] = {'ok': True, 'interval_s': interval}
        except Exception as exc:
            logger.exception('consolidation loop start failed')
            errors.append(f'consolidation: {exc}')
            services['consolidation'] = {'ok': False, 'error': str(exc)}
    else:
        services['consolidation'] = {'skipped': True}

    # 5) Cognitive Scheduler instance (idle hooks available for workbench)
    try:
        from app.services.scheduler import Scheduler

        _cognitive_scheduler = Scheduler()
        # Optional: register consolidation as idle job when idle threshold hits
        if layers.get('consolidation'):

            async def _idle_consolidate() -> None:
                from app.services.consolidation_daemon import runConsolidation

                await runConsolidation()

            idle_s = float(os.environ.get('AUGUST_CONSOLIDATION_IDLE_S', '1800'))
            _cognitive_scheduler.registerIdle('consolidation_idle', _idle_consolidate, idle_s)
        await _cognitive_scheduler.start()
        services['cognitive_scheduler'] = {'ok': True}
        if app is not None and hasattr(app, 'state'):
            app.state.cognitive_scheduler = _cognitive_scheduler  # type: ignore[attr-defined]
    except Exception as exc:
        logger.exception('cognitive Scheduler start failed')
        errors.append(f'cognitive_scheduler: {exc}')
        services['cognitive_scheduler'] = {'ok': False, 'error': str(exc)}

    # 6) Environment watcher — only when flagged (needs workspace root later)
    if layers.get('environment_watcher'):
        services['environment_watcher'] = {
            'ok': True,
            'note': 'enabled; watchers attach per-session when workspacePath is set',
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

    _status['started'] = True
    _status['services'] = services
    _status['errors'] = errors
    if app is not None and hasattr(app, 'state'):
        app.state.cognitive_boot = get_boot_status()  # type: ignore[attr-defined]
    logger.info('Cognitive boot complete: %s', {k: v for k, v in services.items()})
    return get_boot_status()


async def stop_cognitive_services() -> None:
    """Cancel background tasks started by ``start_cognitive_services``."""
    global _cognitive_scheduler
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

    _status['started'] = False
    logger.info('Cognitive services stopped')
