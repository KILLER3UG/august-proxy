"""
FastAPI application entry point.

Serves the SPA from web-dist/ and routes API requests.
This is the Python equivalent of the original Node.js index.js.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.version import backend_version


def _cors_allow_origins() -> list[str]:
    """Explicit origins for credentialed CORS (wildcard + credentials is invalid)."""
    port = settings.port
    origins = [
        f'http://localhost:{port}',
        f'http://127.0.0.1:{port}',
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'tauri://localhost',
        'https://tauri.localhost',
        'http://tauri.localhost',
    ]
    extra = os.environ.get('AUGUST_CORS_ORIGINS', '')
    if extra.strip():
        origins.extend(o.strip() for o in extra.split(',') if o.strip())
    # Preserve order, drop duplicates
    return list(dict.fromkeys(origins))

logger = logging.getLogger(__name__)


def _docs_enabled() -> bool:
    """FastAPI /docs exposure: off unless AUGUST_ENABLE_DOCS=1."""
    import os

    return os.environ.get('AUGUST_ENABLE_DOCS') == '1'

# Enforce the supported Python floor. The project targets 3.12+ (see
# requires-python in pyproject.toml and the CI pin); PEP 695 type aliases and
# other 3.12-only syntax are used throughout. Fail fast with a clear message
# instead of a cryptic SyntaxError deep in the import graph on older runtimes.
import sys  # noqa: E402

if sys.version_info < (3, 12):
    raise RuntimeError(
        f'August Proxy requires Python 3.12 or newer (running {sys.version.split()[0]}). '
        'Please upgrade your Python interpreter.'
    )


class WebSocketLogHandler(logging.Handler):
    """Forward stdlib log records into the WS log-event stream (hub).

    Runs at INFO level so it does not flood the monitor. Records are
    emitted with category ``info`` by default; the hub redacts secret
    shaped metadata values.
    """

    LEVEL_MAP = {
        'DEBUG': 'debug',
        'INFO': 'info',
        'WARNING': 'warn',
        'ERROR': 'error',
        'CRITICAL': 'error',
    }

    def emit(self, record: logging.LogRecord) -> None:
        from app.services import log_stream

        try:
            level = self.LEVEL_MAP.get(record.levelname, 'info')
            log_stream.emitLogEvent(
                {
                    'category': 'info',
                    'level': level,
                    'message': self.format(record),
                    'metadata': {'logger': record.name, 'module': record.module},
                }
            )
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Structured logging must be first — all subsequent log calls benefit.
    from app.lib.logging_config import setup_logging

    setup_logging()

    # Register lifecycle hooks (secret guard, blast radius, test mapping, sensitive code).
    try:
        from app.services.hooks.builtin import register_builtin_hooks

        register_builtin_hooks()
    except Exception as exc:
        logger.warning('Hook registration failed (non-fatal): %s', exc)

    # Start background health monitor for configured providers.
    try:
        from app.services.health_monitor import health_monitor

        await health_monitor.start()
    except Exception as exc:
        logger.warning('Health monitor start failed (non-fatal): %s', exc)

    settings.reload()
    # Mirror Google OAuth keys from .env / process env into durable mcpGlobalEnv
    # so Integrations UI and MCP subprocesses keep them across restarts.
    try:
        import os

        from app.services.service_connections import set_mcp_env

        oauth_patch: dict[str, str] = {}
        for key in (
            'GOOGLE_OAUTH_CLIENT_ID',
            'GOOGLE_OAUTH_CLIENT_SECRET',
            'GOOGLE_OAUTH_REDIRECT_URI',
            'OAUTHLIB_INSECURE_TRANSPORT',
        ):
            val = (os.environ.get(key) or '').strip()
            if val:
                oauth_patch[key] = val
        if oauth_patch:
            set_mcp_env(oauth_patch, merge=True)
            logger.info('Loaded Google OAuth env keys into mcpGlobalEnv: %s', sorted(oauth_patch))
    except Exception as exc:
        logger.warning('Could not mirror Google OAuth env: %s', exc)
    # Start the thread-safe log-stream hub (WS fan-out + ring buffer).
    from app.services import log_stream

    await log_stream.startHub()
    wsHandler = WebSocketLogHandler()
    wsHandler.setLevel(logging.INFO)
    logging.getLogger().addHandler(wsHandler)
    from app.services import tool_definitions

    tool_definitions.registerAll()
    from app.services import memory_store

    memory_store.init()
    from app.lib.paths import dataPath

    _dbPathVal = dataPath('august_brain.sqlite')
    if _dbPathVal.exists():
        # Table/column camel→snake runs inside memory_store.init() → ensure_schema.
        # Historical scripts.migrateDbColumns (snake→camel) must NOT re-run.
        try:
            from app.lib.storage_key_migration import migrate_storage_keys

            migrate_storage_keys(_dbPathVal)
        except Exception as exc:
            logger.warning('Storage-key migration skipped: %s', exc)
    try:
        from app.services.tools.mcp_client import refreshMcpTools

        asyncio.create_task(refreshMcpTools())
    except Exception:
        pass
    # Cognitive layers: cron scheduler, daemon manager, facts-expiry sweep.
    try:
        from app.services.cognitive_boot import start_cognitive_services

        await start_cognitive_services(app)
    except Exception:
        logger.exception('Cognitive boot failed (continuing without background layers)')
    _gateway = None
    try:
        from app.services.gateway.runner import startGateway

        _gateway = await startGateway(settings)
        app.state.gateway_runner = _gateway
    except Exception:
        pass
    try:
        from app.services.runtime_services import get_orchestrator

        get_orchestrator(app)
        logger.info('Subagent orchestrator ready')
    except Exception:
        logger.exception('Runtime services (orchestrator) failed to start')
    # Harness self-improvement (0.17.0): scheduled off-hours introspection —
    # auto-files observation proposals, never applies anything.
    try:
        from app.services.harness_self_improve import scheduled_introspection_loop

        asyncio.create_task(scheduled_introspection_loop())
        logger.info('Harness introspection loop started')
    except Exception:
        logger.exception('Harness introspection loop failed to start (continuing)')
    yield
    # Tear down the log-stream hub and root handler on shutdown.
    try:
        logging.getLogger().removeHandler(wsHandler)
    except Exception:
        pass
    try:
        await log_stream.stopHub()
    except Exception:
        pass
    try:
        from app.services.cognitive_boot import stop_cognitive_services

        await stop_cognitive_services()
    except Exception:
        pass
    try:
        from app.services.runtime_services import shutdown_runtime_services

        await shutdown_runtime_services()
    except Exception:
        pass
    # Flush debounced workbench session saves — the daemon timer dies with
    # the process, so edits inside the debounce window would be lost
    # (audit finding).
    try:
        from app.services.workbench.sessions import flush_pending_saves

        flush_pending_saves()
    except Exception:
        pass
    # Drain the async event-log persistence queue — buffered SSE events
    # would otherwise be lost to restart-replay (round-5 hot-path fix).
    try:
        from app.services.event_log import event_log

        event_log.flush(timeout=10.0)
    except Exception:
        pass
    if _gateway is not None:
        try:
            await _gateway.stop()
        except Exception:
            pass
    try:
        from app.services.browser.session_manager import closeAll as closeBrowsers

        await closeBrowsers()
    except Exception:
        pass
    try:
        from app.services.daemon_manager import shutdownAll

        await shutdownAll()
    except Exception:
        pass


app = FastAPI(
    title='August Proxy',
    version=backend_version(),
    lifespan=lifespan,
    # /docs + /openapi.json enumerate the full API surface to any local
    # caller — off by default; re-enable with AUGUST_ENABLE_DOCS=1 when
    # developing (audit finding).
    docs_url='/docs' if _docs_enabled() else None,
    openapi_url='/openapi.json' if _docs_enabled() else None,
    redoc_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


# Request correlation ID middleware (Phase 1.2)
@app.middleware('http')
async def _request_id_middleware(request, call_next):
    import uuid

    from app.lib.logging_config import request_id_var

    rid = request.headers.get('x-august-request-id') or uuid.uuid4().hex[:16]
    token = request_id_var.set(rid)
    try:
        response = await call_next(request)
        response.headers['X-August-Request-Id'] = rid
        return response
    finally:
        request_id_var.reset(token)
from app.routers import agents as agentsRoutes  # noqa: E402
from app.routers import audit as auditRoutes  # noqa: E402
from app.routers import aug as augRoutes  # noqa: E402
from app.routers import august as augustRoutes  # noqa: E402
from app.routers import automations as automationsRoutes  # noqa: E402
from app.routers import brain_config as brainConfigRoutes  # noqa: E402
from app.routers import browser as browserRoutes  # noqa: E402
from app.routers import calendar as calendarRoutes  # noqa: E402
from app.routers import code_review as codeReviewRoutes  # noqa: E402
from app.routers import config as configRoutes  # noqa: E402
from app.routers import cron as cronRoutes  # noqa: E402
from app.routers import daemons as daemonsRoutes  # noqa: E402
from app.routers import desktop_automation as desktopAutomationRoutes  # noqa: E402
from app.routers import exam as examRoutes  # noqa: E402
from app.routers import gateway as gatewayRoutes  # noqa: E402
from app.routers import git as gitRoutes  # noqa: E402
from app.routers import harness_mcp as harnessMcpRoutes  # noqa: E402
from app.routers import harness_proposals as harnessProposalsRoutes  # noqa: E402
from app.routers import hooks as hooksRoutes  # noqa: E402
from app.routers import live as liveRoutes  # noqa: E402
from app.routers import manage as manageRoutes  # noqa: E402
from app.routers import mcp as mcpRoutes  # noqa: E402
from app.routers import models as modelsRoutes  # noqa: E402
from app.routers import monitor_feature_flow as monitorFeatureFlowRoutes  # noqa: E402
from app.routers import monitoring as monitoringRoutes  # noqa: E402
from app.routers import preview as previewRoutes  # noqa: E402
from app.routers import privacy as privacyRoutes  # noqa: E402
from app.routers import providers as providersRoutes  # noqa: E402
from app.routers import proxy as proxyRoutes  # noqa: E402
from app.routers import realtime as realtimeRoutes  # noqa: E402
from app.routers import recurring_tasks as recurringTasksRoutes  # noqa: E402
from app.routers import refine_store as refineStoreRoutes  # noqa: E402
from app.routers import security as securityRoutes  # noqa: E402
from app.routers import service_connections as serviceConnectionsRoutes  # noqa: E402
from app.routers import sessions as sessionsRoutes  # noqa: E402
from app.routers import skills as skillsRoutes  # noqa: E402
from app.routers import subagent as subagentRoutes  # noqa: E402
from app.routers import terminal as terminalRoutes  # noqa: E402
from app.routers import terminal_routes as terminalWsRoutes  # noqa: E402
from app.routers import whats_new as whatsNewRoutes  # noqa: E402
from app.routers import workbench as workbenchRoutes  # noqa: E402

app.include_router(configRoutes.router)
app.include_router(hooksRoutes.router)
app.include_router(providersRoutes.router)
app.include_router(privacyRoutes.router)
app.include_router(skillsRoutes.router)
app.include_router(cronRoutes.router)
app.include_router(modelsRoutes.router)
app.include_router(proxyRoutes.router)
app.include_router(workbenchRoutes.router)
app.include_router(sessionsRoutes.router)
app.include_router(auditRoutes.router)
app.include_router(agentsRoutes.router)
app.include_router(mcpRoutes.router)
app.include_router(gitRoutes.router)
app.include_router(desktopAutomationRoutes.router)
app.include_router(browserRoutes.router)
# terminal_routes (literal /sessions, /buffer, …) must be registered before
# terminal's /{sessionId} catch-all, or "sessions" is treated as an id.
app.include_router(terminalWsRoutes.router)
app.include_router(terminalRoutes.router)
app.include_router(manageRoutes.router)
app.include_router(monitoringRoutes.router)
app.include_router(monitorFeatureFlowRoutes.router)
app.include_router(augustRoutes.router)
app.include_router(gatewayRoutes.router)
app.include_router(augRoutes.router)
app.include_router(brainConfigRoutes.router)
app.include_router(examRoutes.router)
app.include_router(liveRoutes.router)
app.include_router(calendarRoutes.router)
app.include_router(subagentRoutes.router)
app.include_router(harnessMcpRoutes.router)
app.include_router(harnessProposalsRoutes.router)
app.include_router(refineStoreRoutes.router)
app.include_router(codeReviewRoutes.router)
app.include_router(recurringTasksRoutes.router)
app.include_router(daemonsRoutes.router)
app.include_router(serviceConnectionsRoutes.router)
app.include_router(automationsRoutes.router)
app.include_router(previewRoutes.router)
app.include_router(securityRoutes.router)
app.include_router(realtimeRoutes.router)
app.include_router(whatsNewRoutes.router)
_WEBDist = settings.webDist
if _WEBDist.is_dir():
    app.mount('/assets', StaticFiles(directory=str(_WEBDist / 'assets')), name='assets')

    @app.exception_handler(404)
    async def spaFallback(request, exc):
        """Return index.html for unmatched routes.

        API routes (/api/, /v1/) return a JSON 404 so the frontend
        doesn't try to parse HTML as SSE/JSON.
        """
        path = request.url.path
        if path.startswith('/api/') or path.startswith('/v1/'):
            from fastapi.responses import JSONResponse

            return JSONResponse({'error': 'Not found', 'path': path}, status_code=404)
        index = _WEBDist / 'index.html'
        if index.exists():
            return FileResponse(str(index))
        from fastapi.responses import JSONResponse

        return JSONResponse(
            {'error': 'Web UI not found', 'path': path},
            status_code=404,
        )


_startedAt: float = time.time()


@app.get('/api/health')
async def health():
    """Single source of truth for /api/health.

    Returns both the app-health fields (status/version/python) asserted by
    tests and the gateway fields (port/uptime) polled by the desktop gateway
    store (frontend/desktop/src/store/gateway.ts). The monitoring router's
    /health handler was removed to avoid a first-match-wins collision that
    dropped the `python` field.
    """
    return {
        'status': 'ok',
        'version': backend_version(),
        'python': True,
        'port': settings.port,
        'uptime': time.time() - _startedAt,
    }


@app.get('/api/health/detailed')
async def healthDetailed():
    """Detailed health snapshot — used by System Health and API Access panels.

    Includes ``externalAccess`` so the UI can show whether the proxy
    gateway is currently open for external clients.
    """
    try:
        cfg = settings.config or {}
    except Exception:
        cfg = {}
    gw = cfg.get('gateway') or {}
    ea = gw.get('externalAccess') or {}
    enabled = bool(ea.get('enabled', False))
    try:
        from app.lib.gateway_auth import resolve_gateway_api_key

        hasKey = bool(resolve_gateway_api_key())
    except Exception:
        hasKey = bool(settings.gatewayApiKey)
    brain_sync = {}
    cognitive = {}
    try:
        from app.services.workbench.brain_sync import get_sync_stats

        brain_sync = get_sync_stats()
    except Exception as exc:
        brain_sync = {'error': str(exc)}
    try:
        from app.services.cognitive_boot import get_boot_status

        cognitive = get_boot_status()
    except Exception as exc:
        cognitive = {'error': str(exc)}
    # Top-level status must reflect background services — 'ok' only when the
    # brain sync and cognitive boot are healthy too.
    bg_issues: list[str] = []
    if isinstance(brain_sync, dict) and brain_sync.get('error'):
        bg_issues.append(f'brainSync: {brain_sync["error"]}')
    if isinstance(cognitive, dict) and cognitive.get('error'):
        bg_issues.append(f'cognitiveBoot: {cognitive["error"]}')
    return {
        'status': 'degraded' if bg_issues else 'ok',
        'backgroundIssues': bg_issues,
        'mode': 'python',
        'port': settings.port,
        'data_dir': str(settings.dataDir),
        'externalAccess': {'enabled': enabled, 'hasKey': hasKey, 'configured': enabled and hasKey},
        'brainSync': brain_sync,
        'cognitiveBoot': cognitive,
    }
