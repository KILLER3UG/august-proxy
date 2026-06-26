"""UI automation service — coordinates screen capture, mouse/keyboard, and browser control."""

from __future__ import annotations

from typing import Any

from app.services.computer_use import (
    take_screenshot, get_mouse_position, get_screen_size,
    click_mouse, type_text, press_key, browser_navigate,
)


async def automate_action(action: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """Execute a UI automation action."""
    params = params or {}
    actions = {
        "screenshot": lambda: take_screenshot(),
        "mouse_position": lambda: get_mouse_position(),
        "screen_size": lambda: get_screen_size(),
        "click": lambda: click_mouse(params.get("x", 0), params.get("y", 0), params.get("button", "left")),
        "type": lambda: type_text(params.get("text", "")),
        "press": lambda: press_key(params.get("key", "")),
        "navigate": lambda: browser_navigate(params.get("url", "")),
    }
    handler = actions.get(action)
    if not handler:
        return {"error": f"Unknown action: {action}"}
    return await handler()
