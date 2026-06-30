"""Desktop automation dispatcher — routes an action string to the matching
pyautogui-backed desktop function.

Thin orchestration layer over :mod:`app.services.desktop_automation`.
Distinct from the headless browser automation in :mod:`app.services.browser`:
this layer controls the user's real physical desktop (screen/mouse/keyboard),
while the browser layer drives an invisible Playwright page.
"""
from __future__ import annotations
from app.services.desktopAutomation import takeScreenshot, getMousePosition, getScreenSize, clickMouse, typeText, pressKey, openUrl, listWindows

async def automateAction(action: str, params: dict[str, object] | None=None) -> dict[str, object] | list[dict[str, object]]:
    """Execute a desktop automation action by name.

    Recognised actions: ``screenshot``, ``mouse_position``, ``screen_size``,
    ``click`` (x, y, button), ``type`` (text), ``press`` (key), ``navigate``
    (url — opens the default visible browser), ``list_windows``.
    """
    params = params or {}
    actions: dict[str, object] = {'screenshot': lambda: takeScreenshot(), 'mouse_position': lambda: getMousePosition(), 'screen_size': lambda: getScreenSize(), 'click': lambda: clickMouse(params.get('x', 0), params.get('y', 0), params.get('button', 'left')), 'type': lambda: typeText(params.get('text', '')), 'press': lambda: pressKey(params.get('key', '')), 'navigate': lambda: openUrl(params.get('url', '')), 'list_windows': lambda: listWindows()}
    handler = actions.get(action)
    if not handler:
        return {'error': f'Unknown action: {action}'}
    return await handler()