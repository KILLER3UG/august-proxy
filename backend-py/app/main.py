"""
FastAPI application entry point.

Serves the SPA from web-dist/ and routes API requests.
This is the Python equivalent of the original Node.js index.js.
"""

from __future__ import annotations

import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from app.config import settings
# database.py removed in Phase 0 — SQLAlchemy was dead code (no ORM models exist).
# Session lifecycle is managed by memory_store.py (august_brain.sqlite) directly.


# ── Lifespan ──────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.reload()
    # Register tool handlers
    from app.services import tool_definitions

    tool_definitions.register_all()
    # Ensure brain SQLite tables (incl. config_audit) exist.
    from app.services import memory_store
    memory_store.init()
    # Discover MCP server tools fire-and-forget so they appear in the
    # workbench tool list shortly after boot. MCP servers are optional —
    # refresh_mcp_tools swallows per-server failures, and the workbench
    # re-reads the (lazily-populated) cache on every generation, so a
    # slow/missing server never blocks startup.
    try:
        from app.services.tools.mcp_client import refresh_mcp_tools
        asyncio.create_task(refresh_mcp_tools())
    except Exception:
        pass
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
    # Phase 8: Shutdown daemon manager (cancel all background daemon tasks)
    try:
        from app.services.daemon_manager import shutdown_all
        await shutdown_all()
    except Exception:
        pass
    # close_db() removed in Phase 0 — SQLAlchemy was dead code.
    # memory_store cleanup (if any) happens in memory_store.close() if needed.


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
from app.routers import desktop_automation as desktop_automation_routes
from app.routers import browser as browser_routes
from app.routers import terminal as terminal_routes
from app.routers import terminal_routes as terminal_ws_routes
from app.routers import manage as manage_routes
from app.routers import monitoring as monitoring_routes
from app.routers import august as august_routes
from app.routers import gateway as gateway_routes
from app.routers import curator as curator_routes
from app.routers import ui_memory as ui_memory_routes

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
app.include_router(desktop_automation_routes.router)
app.include_router(browser_routes.router)
app.include_router(terminal_routes.router)
app.include_router(terminal_ws_routes.router)
app.include_router(manage_routes.router)
app.include_router(monitoring_routes.router)
app.include_router(august_routes.router)
app.include_router(gateway_routes.router)
app.include_router(ui_memory_routes.router)


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

_started_at: float = time.time()


@app.get("/api/health")
async def health():
    """Single source of truth for /api/health.

    Returns both the app-health fields (status/version/python) asserted by
    tests and the gateway fields (port/uptime) polled by the desktop gateway
    store (frontend/desktop/src/store/gateway.ts). The monitoring router's
    /health handler was removed to avoid a first-match-wins collision that
    dropped the `python` field.
    """
    return {
        "status": "ok",
        "version": "0.1.0",
        "python": True,
        "port": settings.port,
        "uptime": time.time() - _started_at,
    }


@app.get("/api/health/detailed")
async def health_detailed():
    return {
        "status": "ok",
        "mode": "python",
        "port": settings.port,
        "data_dir": str(settings.data_dir),
    }
