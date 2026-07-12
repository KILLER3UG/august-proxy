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
from fastapi import APIRouter
from pydantic import BaseModel, Field
from app.services.desktop_automation import (
    getScreenSize,
)
from app.services.desktop_dispatch import automateAction

router = APIRouter(prefix='/api/desktop-automation', tags=['desktop-automation'])


def _isAvailable() -> bool:
    try:
        import pyautogui

        del pyautogui  # availability probe only
        return True
    except ImportError:
        return False


@router.get('/health')
async def health() -> dict[str, object]:
    """Report desktop-automation capability and a live probe.

    Returns ``overall`` ∈ ok|error so the settings page can render a status.
    """
    checks: list[dict[str, object]] = []
    overall = 'ok'
    if _isAvailable():
        checks.append(
            {
                'name': 'pyautogui',
                'status': 'ok',
                'message': 'pyautogui is installed; desktop control is available.',
                'details': {'solution': None},
            }
        )
        try:
            size = await getScreenSize()
            if 'error' in size:
                checks.append(
                    {
                        'name': 'screen probe',
                        'status': 'error',
                        'message': str(size['error']),
                        'details': {'solution': 'Run the proxy on a host with an active display.'},
                    }
                )
                overall = 'error'
            else:
                checks.append(
                    {
                        'name': 'screen probe',
                        'status': 'ok',
                        'message': f'Screen {size["width"]}x{size["height"]} detected.',
                        'details': {'solution': None},
                    }
                )
        except Exception as exc:
            checks.append(
                {
                    'name': 'screen probe',
                    'status': 'error',
                    'message': f'Screen probe failed: {exc}',
                    'details': {'solution': 'Ensure a display is attached (not a headless server).'},
                }
            )
            overall = 'error'
    else:
        overall = 'error'
        checks.append(
            {
                'name': 'pyautogui',
                'status': 'error',
                'message': 'pyautogui is not installed.',
                'details': {'solution': 'Run `uv sync --extra desktop` to enable desktop automation.'},
            }
        )
    return {'platform': _platform(), 'overall': overall, 'checks': checks, 'timestamp': _nowIso()}


@router.get('/config')
async def config() -> dict[str, object]:
    """Return the effective desktop-automation configuration.

    No persistent config exists yet, so we report static defaults that the
    settings UI renders. ``backend`` names the engine so the page label stays
    accurate instead of the misleading legacy ``cua``.
    """
    return {
        'enabled': _isAvailable(),
        'backend': 'pyautogui',
        'autoApprove': ['screenshot', 'mouse_position', 'screen_size', 'list_windows'],
        'blocklistKeys': ['ctrl+alt+del', 'cmd+q'],
        'blocklistPatterns': [],
    }


class ActionRequest(BaseModel):
    action: str = Field(..., description='screenshot|mouse_position|screen_size|click|type|press|navigate|list_windows')
    params: dict[str, object] = Field(default_factory=dict)


@router.post('/action')
async def runAction(body: ActionRequest) -> object:
    """Execute a desktop automation action by name.

    This is the programmatic counterpart to the ``desktop_*`` tools; it lets
    the settings page (or an external caller) drive the desktop without going
    through the workbench chat loop.
    """
    return await automateAction(body.action, body.params)


def _platform() -> str:
    import sys

    return {'win32': 'windows', 'darwin': 'macos', 'linux': 'linux'}.get(sys.platform, sys.platform)


def _nowIso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
