"""Computer use service — screen, mouse, keyboard, and browser automation.

Port of backend/services/computer-use/ (4 files).
"""

from __future__ import annotations

import asyncio
import subprocess
from typing import Any


async def take_screenshot() -> dict[str, Any]:
    """Take a screenshot. Returns base64-encoded PNG."""
    try:
        import pyautogui
        import io
        import base64
        screenshot = pyautogui.screenshot()
        buf = io.BytesIO()
        screenshot.save(buf, format="PNG")
        return {"screenshot": base64.b64encode(buf.getvalue()).decode(), "format": "png"}
    except ImportError:
        return {"error": "pyautogui not installed"}


async def get_mouse_position() -> dict[str, Any]:
    try:
        import pyautogui
        x, y = pyautogui.position()
        return {"x": x, "y": y}
    except ImportError:
        return {"error": "pyautogui not installed"}


async def get_screen_size() -> dict[str, Any]:
    try:
        import pyautogui
        w, h = pyautogui.size()
        return {"width": w, "height": h}
    except ImportError:
        return {"error": "pyautogui not installed"}


async def click_mouse(x: int, y: int, button: str = "left") -> dict[str, Any]:
    try:
        import pyautogui
        pyautogui.click(x, y, button=button)
        return {"x": x, "y": y, "button": button}
    except ImportError:
        return {"error": "pyautogui not installed"}


async def type_text(text: str) -> dict[str, Any]:
    try:
        import pyautogui
        pyautogui.write(text)
        return {"typed": len(text)}
    except ImportError:
        return {"error": "pyautogui not installed"}


async def press_key(key: str) -> dict[str, Any]:
    try:
        import pyautogui
        pyautogui.press(key)
        return {"key": key}
    except ImportError:
        return {"error": "pyautogui not installed"}


async def list_windows() -> list[dict[str, Any]]:
    windows = []
    try:
        import pygetwindow as gw
        for w in gw.getWindowsWithTitle(""):
            windows.append({"title": w.title, "left": w.left, "top": w.top, "width": w.width, "height": w.height})
    except ImportError:
        return [{"note": "pygetwindow not installed"}]
    return windows


async def browser_navigate(url: str) -> dict[str, Any]:
    """Open a URL in the default browser."""
    import webbrowser
    webbrowser.open(url)
    return {"url": url, "status": "opened"}
