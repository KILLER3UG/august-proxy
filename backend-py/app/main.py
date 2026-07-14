"""
FastAPI application entry point.

Serves the SPA from web-dist/ and routes API requests.
This is the Python equivalent of the original Node.js index.js.
"""

from __future__ import annotations
import asyncio
import logging
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.config import settings

logger = logging.getLogger(__name__)

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
    settings.reload()
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
    _gateway = None
    try:
        from app.services.gateway.runner import startGateway

        _gateway = await startGateway(settings)
        app.state.gateway_runner = _gateway
    except Exception:
        pass
    _curator = None
    _curatorTask = None
    try:
        from app.services.skills.curator import make_background_curator

        _curator, _curatorTask = make_background_curator()
        app.state.curator = _curator
    except Exception:
        pass
    _orchestrator = None
    try:
        from app.services.agent_message_bus import AgentMessageBus
        from app.services.subagent_orchestrator import SubagentOrchestrator

        _bus = AgentMessageBus()
        _orchestrator = SubagentOrchestrator(_bus, max_workers=5)
        app.state.subagent_bus = _bus
        app.state.subagent_orchestrator = _orchestrator
        logger.info('Subagent orchestrator initialized (max_workers=5)')
    except Exception:
        logger.warning('Subagent orchestrator initialization skipped')
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
    if _orchestrator is not None:
        try:
            await _orchestrator.close()
        except Exception:
            pass
    if _curatorTask is not None:
        _curatorTask.cancel()
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


app = FastAPI(title='August Proxy', version='0.1.0', lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=['*'], allow_credentials=True, allow_methods=['*'], allow_headers=['*']
)
from app.routers import config as configRoutes  # noqa: E402
from app.routers import providers as providersRoutes  # noqa: E402
from app.routers import skills as skillsRoutes  # noqa: E402
from app.routers import models as modelsRoutes  # noqa: E402
from app.routers import proxy as proxyRoutes  # noqa: E402
from app.routers import workbench as workbenchRoutes  # noqa: E402
from app.routers import sessions as sessionsRoutes  # noqa: E402
from app.routers import memory as memoryRoutes  # noqa: E402
from app.routers import audit as auditRoutes  # noqa: E402
from app.routers import usage as usageRoutes  # noqa: E402
from app.routers import agents as agentsRoutes  # noqa: E402
from app.routers import mcp as mcpRoutes  # noqa: E402
from app.routers import cron as cronRoutes  # noqa: E402
from app.routers import git as gitRoutes  # noqa: E402
from app.routers import desktop_automation as desktopAutomationRoutes  # noqa: E402
from app.routers import browser as browserRoutes  # noqa: E402
from app.routers import terminal as terminalRoutes  # noqa: E402
from app.routers import terminal_routes as terminalWsRoutes  # noqa: E402
from app.routers import manage as manageRoutes  # noqa: E402
from app.routers import monitoring as monitoringRoutes  # noqa: E402
from app.routers import august as augustRoutes  # noqa: E402
from app.routers import gateway as gatewayRoutes  # noqa: E402
from app.routers import curator as curatorRoutes  # noqa: E402
from app.routers import ui_memory as uiMemoryRoutes  # noqa: E402
from app.routers import aug as augRoutes  # noqa: E402
from app.routers import brain as brainRoutes  # noqa: E402
from app.routers import brain_activity as brainActivityRoutes  # noqa: E402
from app.routers import brain_config as brainConfigRoutes  # noqa: E402
from app.routers import exam as examRoutes  # noqa: E402
from app.routers import live as liveRoutes  # noqa: E402
from app.routers import calendar as calendarRoutes  # noqa: E402
from app.routers import subagent as subagentRoutes  # noqa: E402

app.include_router(configRoutes.router)
app.include_router(providersRoutes.router)
app.include_router(skillsRoutes.router)
app.include_router(curatorRoutes.router)
app.include_router(modelsRoutes.router)
app.include_router(proxyRoutes.router)
app.include_router(workbenchRoutes.router)
app.include_router(sessionsRoutes.router)
app.include_router(memoryRoutes.router)
app.include_router(auditRoutes.router)
app.include_router(usageRoutes.router)
app.include_router(agentsRoutes.router)
app.include_router(mcpRoutes.router)
app.include_router(cronRoutes.router)
app.include_router(gitRoutes.router)
app.include_router(desktopAutomationRoutes.router)
app.include_router(browserRoutes.router)
app.include_router(terminalRoutes.router)
app.include_router(terminalWsRoutes.router)
app.include_router(manageRoutes.router)
app.include_router(monitoringRoutes.router)
app.include_router(augustRoutes.router)
app.include_router(gatewayRoutes.router)
app.include_router(augRoutes.router)
app.include_router(uiMemoryRoutes.router)
app.include_router(brainRoutes.router)
app.include_router(brainConfigRoutes.router)
app.include_router(brainActivityRoutes.router)
app.include_router(examRoutes.router)
app.include_router(liveRoutes.router)
app.include_router(calendarRoutes.router)
app.include_router(subagentRoutes.router)
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
        return FileResponse(str(index)) if index.exists() else None


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
        'version': '0.1.0',
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
    hasKey = bool(settings.gatewayApiKey)
    return {
        'status': 'ok',
        'mode': 'python',
        'port': settings.port,
        'data_dir': str(settings.dataDir),
        'externalAccess': {'enabled': enabled, 'hasKey': hasKey, 'configured': enabled and hasKey},
    }
