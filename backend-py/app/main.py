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
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.config import settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.reload()
    from app.services import toolDefinitions
    toolDefinitions.registerAll()
    from app.services import memoryStore
    memoryStore.init()
    # Run database column migration (snake_case → camelCase)
    from app.lib.paths import dataPath
    _db_path_val = dataPath("august_brain.sqlite")
    if _db_path_val.exists():
        try:
            from scripts.migrateDbColumns import migrateDatabase
            migrateDatabase(_db_path_val)
            logger.info("Database columns migrated: snake_case → camelCase")
        except Exception as exc:
            logger.warning("DB migration skipped: %s", exc)
    try:
        from app.services.tools.mcpClient import refreshMcpTools
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
        from app.services.skills.curator import makeBackgroundCurator
        _curator, _curatorTask = makeBackgroundCurator()
        app.state.curator = _curator
    except Exception:
        pass
    yield
    if _curatorTask is not None:
        _curatorTask.cancel()
    if _gateway is not None:
        try:
            await _gateway.stop()
        except Exception:
            pass
    try:
        from app.services.browser.sessionManager import close_all as closeBrowsers
        await closeBrowsers()
    except Exception:
        pass
    try:
        from app.services.daemonManager import shutdownAll
        await shutdownAll()
    except Exception:
        pass
app = FastAPI(title='August Proxy', version='0.1.0', lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_credentials=True, allow_methods=['*'], allow_headers=['*'])
from app.routers import config as configRoutes
from app.routers import providers as providersRoutes
from app.routers import skills as skillsRoutes
from app.routers import models as modelsRoutes
from app.routers import proxy as proxyRoutes
from app.routers import workbench as workbenchRoutes
from app.routers import sessions as sessionsRoutes
from app.routers import memory as memoryRoutes
from app.routers import audit as auditRoutes
from app.routers import usage as usageRoutes
from app.routers import agents as agentsRoutes
from app.routers import mcp as mcpRoutes
from app.routers import cron as cronRoutes
from app.routers import git as gitRoutes
from app.routers import desktopAutomation as desktopAutomationRoutes
from app.routers import browser as browserRoutes
from app.routers import terminal as terminalRoutes
from app.routers import terminalRoutes as terminalWsRoutes
from app.routers import manage as manageRoutes
from app.routers import monitoring as monitoringRoutes
from app.routers import august as augustRoutes
from app.routers import gateway as gatewayRoutes
from app.routers import curator as curatorRoutes
from app.routers import uiMemory as uiMemoryRoutes
from app.routers import brain as brainRoutes
from app.routers import brainActivity as brainActivityRoutes
from app.routers import brainConfig as brainConfigRoutes
from app.routers import exam as examRoutes
from app.routers import live as liveRoutes
from app.routers import calendar as calendarRoutes
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
app.include_router(uiMemoryRoutes.router)
app.include_router(brainRoutes.router)
app.include_router(brainConfigRoutes.router)
app.include_router(brainActivityRoutes.router)
app.include_router(examRoutes.router)
app.include_router(liveRoutes.router)
app.include_router(calendarRoutes.router)
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
    return {'status': 'ok', 'version': '0.1.0', 'python': True, 'port': settings.port, 'uptime': time.time() - _startedAt}

@app.get('/api/health/detailed')
async def healthDetailed():
    return {'status': 'ok', 'mode': 'python', 'port': settings.port, 'data_dir': str(settings.dataDir)}