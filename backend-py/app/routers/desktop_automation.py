"""Desktop automation API routes.

Surfaces the pyautogui-backed desktop computer-use layer (real
screen/mouse/keyboard) to the frontend's "Computer Use" settings page.

Distinct from the headless browser automation in ``app.routers`` browser
tooling: this router controls the user's actual physical desktop.

Endpoints:
- ``GET  /api/desktop-automation/health`` — capability check + live diagnostics
- ``GET  /api/desktop-automation/config`` — effective configuration
- ``POST /api/desktop-automation/action`` — run a desktop action by name
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.services.desktop_automation import (
    click_mouse,
    get_mouse_position,
    get_screen_size,
    list_windows,
    open_url,
    press_key,
    take_screenshot,
    type_text,
)
from app.services.desktop_dispatch import automate_action

router = APIRouter(prefix="/api/desktop-automation", tags=["desktop-automation"])


def _is_available() -> bool:
    try:
        import pyautogui  # noqa: F401
        return True
    except ImportError:
        return False


@router.get("/health")
async def health() -> dict[str, Any]:
    """Report desktop-automation capability and a live probe.

    Returns ``overall`` ∈ ok|error so the settings page can render a status.
    """
    checks: list[dict[str, Any]] = []
    overall = "ok"

    if _is_available():
        checks.append({
            "name": "pyautogui",
            "status": "ok",
            "message": "pyautogui is installed; desktop control is available.",
            "details": {"solution": None},
        })
        try:
            size = await get_screen_size()
            if "error" in size:
                checks.append({
                    "name": "screen probe",
                    "status": "error",
                    "message": str(size["error"]),
                    "details": {"solution": "Run the proxy on a host with an active display."},
                })
                overall = "error"
            else:
                checks.append({
                    "name": "screen probe",
                    "status": "ok",
                    "message": f"Screen {size['width']}x{size['height']} detected.",
                    "details": {"solution": None},
                })
        except Exception as exc:  # noqa: BLE001
            checks.append({
                "name": "screen probe",
                "status": "error",
                "message": f"Screen probe failed: {exc}",
                "details": {"solution": "Ensure a display is attached (not a headless server)."},
            })
            overall = "error"
    else:
        overall = "error"
        checks.append({
            "name": "pyautogui",
            "status": "error",
            "message": "pyautogui is not installed.",
            "details": {"solution": "Run `uv sync --extra desktop` to enable desktop automation."},
        })

    return {
        "platform": _platform(),
        "overall": overall,
        "checks": checks,
        "timestamp": _now_iso(),
    }


@router.get("/config")
async def config() -> dict[str, Any]:
    """Return the effective desktop-automation configuration.

    No persistent config exists yet, so we report static defaults that the
    settings UI renders. ``backend`` names the engine so the page label stays
    accurate instead of the misleading legacy ``cua``.
    """
    return {
        "enabled": _is_available(),
        "backend": "pyautogui",
        "auto_approve": ["screenshot", "mouse_position", "screen_size", "list_windows"],
        "blocklist_keys": ["ctrl+alt+del", "cmd+q"],
        "blocklist_patterns": [],
    }


class ActionRequest(BaseModel):
    action: str = Field(..., description="screenshot|mouse_position|screen_size|click|type|press|navigate|list_windows")
    params: dict[str, Any] = Field(default_factory=dict)


@router.post("/action")
async def run_action(body: ActionRequest) -> Any:
    """Execute a desktop automation action by name.

    This is the programmatic counterpart to the ``desktop_*`` tools; it lets
    the settings page (or an external caller) drive the desktop without going
    through the workbench chat loop.
    """
    return await automate_action(body.action, body.params)


# ── Helpers ──────────────────────────────────────────────────────────


def _platform() -> str:
    import sys
    return {
        "win32": "windows",
        "darwin": "macos",
        "linux": "linux",
    }.get(sys.platform, sys.platform)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
