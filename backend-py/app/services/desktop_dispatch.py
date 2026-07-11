"""Desktop automation dispatcher — routes an action string to the matching
pyautogui-backed desktop function.

Thin orchestration layer over :mod:`app.services.desktop_automation`.
Distinct from the headless browser automation in :mod:`app.services.browser`:
this layer controls the user's real physical desktop (screen/mouse/keyboard),
while the browser layer drives an invisible Playwright page.
"""

from __future__ import annotations
from typing import Any, Awaitable, Callable
from app.jsonUtils import as_str, as_int
from app.services.desktop_automation import (
    takeScreenshot,
    getMousePosition,
    getScreenSize,
    clickMouse,
    typeText,
    pressKey,
    openUrl,
    listWindows,
)


async def automateAction(
    action: str, params: dict[str, object] | None = None
) -> dict[str, object] | list[dict[str, object]]:
    """Execute a desktop automation action by name.

    Recognised actions: ``screenshot``, ``mouse_position``, ``screen_size``,
    ``click`` (x, y, button), ``type`` (text), ``press`` (key), ``navigate``
    (url — opens the default visible browser), ``list_windows``.
    """
    params = params or {}
    actions: dict[str, Callable[[], Awaitable[Any]]] = {
        'screenshot': lambda: takeScreenshot(),
        'mouse_position': lambda: getMousePosition(),
        'screen_size': lambda: getScreenSize(),
        'click': lambda: clickMouse(
            as_int(params.get('x'), 0), as_int(params.get('y'), 0), as_str(params.get('button'), 'left')
        ),
        'type': lambda: typeText(as_str(params.get('text'), '')),
        'press': lambda: pressKey(as_str(params.get('key'), '')),
        'navigate': lambda: openUrl(as_str(params.get('url'), '')),
        'list_windows': lambda: listWindows(),
    }
    handler = actions.get(action)
    if not handler:
        return {'error': f'Unknown action: {action}'}
    return await handler()
