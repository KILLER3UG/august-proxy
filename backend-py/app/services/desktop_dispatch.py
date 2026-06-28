"""Desktop automation dispatcher — routes an action string to the matching
pyautogui-backed desktop function.

Thin orchestration layer over :mod:`app.services.desktop_automation`.
Distinct from the headless browser automation in :mod:`app.services.browser`:
this layer controls the user's real physical desktop (screen/mouse/keyboard),
while the browser layer drives an invisible Playwright page.
"""

from __future__ import annotations

from typing import Any

from app.services.desktop_automation import (
    take_screenshot, get_mouse_position, get_screen_size,
    click_mouse, type_text, press_key, open_url, list_windows,
)


async def automate_action(action: str, params: dict[str, Any] | None = None) -> dict[str, Any] | list[dict[str, Any]]:
    """Execute a desktop automation action by name.

    Recognised actions: ``screenshot``, ``mouse_position``, ``screen_size``,
    ``click`` (x, y, button), ``type`` (text), ``press`` (key), ``navigate``
    (url — opens the default visible browser), ``list_windows``.
    """
    params = params or {}
    actions: dict[str, Any] = {
        "screenshot": lambda: take_screenshot(),
        "mouse_position": lambda: get_mouse_position(),
        "screen_size": lambda: get_screen_size(),
        "click": lambda: click_mouse(params.get("x", 0), params.get("y", 0), params.get("button", "left")),
        "type": lambda: type_text(params.get("text", "")),
        "press": lambda: press_key(params.get("key", "")),
        "navigate": lambda: open_url(params.get("url", "")),
        "list_windows": lambda: list_windows(),
    }
    handler = actions.get(action)
    if not handler:
        return {"error": f"Unknown action: {action}"}
    return await handler()
