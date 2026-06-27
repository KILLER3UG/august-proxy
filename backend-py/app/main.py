"""
FastAPI application entry point.

Serves the SPA from web-dist/ and routes API requests.
This is the Python equivalent of the original Node.js index.js.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.config import settings
from app.database import init_db, close_db


# ── Lifespan ──────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.reload()
    # Register tool handlers
    from app.services import tool_definitions

    tool_definitions.register_all()
    await init_db()
    # Ensure brain SQLite tables (incl. config_audit) exist.
    from app.services import memory_store
    memory_store.init()
    # Start gateway adapters (reads gateway config; no-op if disabled).
    _gateway = None
    try:
        from app.services.gateway.runner import start_gateway
        _gateway = await start_gateway(settings)
        app.state.gateway_runner = _gateway
    except Exception:
        pass
    # Start skill curator background loop.
    _curator = None
    _curator_task = None
    try:
        from app.services.skills.curator import make_background_curator
        _curator, _curator_task = make_background_curator()
        app.state.curator = _curator
    except Exception:
        pass
    yield
    # Shutdown curator
    if _curator_task is not None:
        _curator_task.cancel()
    # Shutdown gateway
    if _gateway is not None:
        try:
            await _gateway.stop()
        except Exception:
            pass
    # Close all headless browser sessions on shutdown.
    try:
        from app.services.browser.session_manager import close_all as close_browsers
        await close_browsers()
    except Exception:
        pass
    await close_db()


# ── App ───────────────────────────────────────────────────────────────


app = FastAPI(
    title="August Proxy",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routers ────────────────────────────────────────────────────────────

from app.routers import config as config_routes
from app.routers import providers as providers_routes
from app.routers import skills as skills_routes
from app.routers import models as models_routes
from app.routers import proxy as proxy_routes
from app.routers import workbench as workbench_routes
from app.routers import sessions as sessions_routes
from app.routers import memory as memory_routes
from app.routers import audit as audit_routes
from app.routers import usage as usage_routes
from app.routers import agents as agents_routes
from app.routers import mcp as mcp_routes
from app.routers import cron as cron_routes
from app.routers import git as git_routes
from app.routers import terminal as terminal_routes
from app.routers import terminal_routes as terminal_ws_routes
from app.routers import manage as manage_routes
from app.routers import monitoring as monitoring_routes
from app.routers import august as august_routes
from app.routers import gateway as gateway_routes
from app.routers import curator as curator_routes

app.include_router(config_routes.router)
app.include_router(providers_routes.router)
app.include_router(skills_routes.router)
app.include_router(curator_routes.router)
app.include_router(models_routes.router)
app.include_router(proxy_routes.router)
app.include_router(workbench_routes.router)
app.include_router(sessions_routes.router)
app.include_router(memory_routes.router)
app.include_router(audit_routes.router)
app.include_router(usage_routes.router)
app.include_router(agents_routes.router)
app.include_router(mcp_routes.router)
app.include_router(cron_routes.router)
app.include_router(git_routes.router)
app.include_router(terminal_routes.router)
app.include_router(terminal_ws_routes.router)
app.include_router(manage_routes.router)
app.include_router(monitoring_routes.router)
app.include_router(august_routes.router)
app.include_router(gateway_routes.router)


# ── Static files (SPA) ────────────────────────────────────────────────

_WEB_DIST = settings.web_dist

if _WEB_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_WEB_DIST / "assets")), name="assets")


    @app.exception_handler(404)
    async def spa_fallback(request, exc):
        """Return index.html for unmatched routes.

        API routes (/api/, /v1/) return a JSON 404 so the frontend
        doesn't try to parse HTML as SSE/JSON.
        """
        path = request.url.path
        if path.startswith("/api/") or path.startswith("/v1/"):
            from fastapi.responses import JSONResponse
            return JSONResponse({"error": "Not found", "path": path}, status_code=404)

        index = _WEB_DIST / "index.html"
        if index.exists():
            return FileResponse(str(index))
        return FileResponse(str(index)) if index.exists() else None


# ── Health ────────────────────────────────────────────────────────────


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0", "python": True}


@app.get("/api/health/detailed")
async def health_detailed():
    return {
        "status": "ok",
        "mode": "python",
        "port": settings.port,
        "data_dir": str(settings.data_dir),
    }
