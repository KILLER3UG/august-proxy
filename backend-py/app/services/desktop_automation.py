"""Desktop automation — real screen, mouse, keyboard via pyautogui.

This is the *desktop* computer-use layer: it controls the user's actual
physical desktop (captures the screen, moves/clicks the real mouse, types
on the real keyboard). It is distinct from the headless browser automation
in ``app.services.browser``, which drives a headless Playwright page.

pyautogui / pygetwindow are imported lazily so the proxy boots even when the
desktop engine isn't installed; tools then return a clear ``{"error": ...}``.
"""

from __future__ import annotations

from typing import Any


async def take_screenshot() -> dict[str, Any]:
    """Capture the real desktop as a base64-encoded PNG."""
    try:
        import pyautogui
        import io
        import base64
        screenshot = pyautogui.screenshot()
        buf = io.BytesIO()
        screenshot.save(buf, format="PNG")
        return {"screenshot": base64.b64encode(buf.getvalue()).decode(), "format": "png"}
    except ImportError:
        return {"error": "pyautogui not installed. Run `uv sync --extra desktop`."}


async def get_mouse_position() -> dict[str, Any]:
    """Return the current real cursor position."""
    try:
        import pyautogui
        x, y = pyautogui.position()
        return {"x": x, "y": y}
    except ImportError:
        return {"error": "pyautogui not installed. Run `uv sync --extra desktop`."}


async def get_screen_size() -> dict[str, Any]:
    """Return the real screen dimensions in pixels."""
    try:
        import pyautogui
        w, h = pyautogui.size()
        return {"width": w, "height": h}
    except ImportError:
        return {"error": "pyautogui not installed. Run `uv sync --extra desktop`."}


async def click_mouse(x: int, y: int, button: str = "left") -> dict[str, Any]:
    """Move the real mouse to (x, y) and click."""
    try:
        import pyautogui
        pyautogui.click(x, y, button=button)
        return {"x": x, "y": y, "button": button}
    except ImportError:
        return {"error": "pyautogui not installed. Run `uv sync --extra desktop`."}


async def type_text(text: str) -> dict[str, Any]:
    """Type ``text`` on the real keyboard."""
    try:
        import pyautogui
        pyautogui.write(text)
        return {"typed": len(text)}
    except ImportError:
        return {"error": "pyautogui not installed. Run `uv sync --extra desktop`."}


async def press_key(key: str) -> dict[str, Any]:
    """Press a single real keyboard key (e.g. ``enter``, ``escape``)."""
    try:
        import pyautogui
        pyautogui.press(key)
        return {"key": key}
    except ImportError:
        return {"error": "pyautogui not installed. Run `uv sync --extra desktop`."}


async def list_windows() -> list[dict[str, Any]]:
    """List visible desktop windows (title + geometry)."""
    windows: list[dict[str, Any]] = []
    try:
        import pygetwindow as gw
        for w in gw.getWindowsWithTitle(""):
            windows.append({"title": w.title, "left": w.left, "top": w.top, "width": w.width, "height": w.height})
    except ImportError:
        return [{"note": "pygetwindow not installed. Run `uv sync --extra desktop`."}]
    return windows


async def open_url(url: str) -> dict[str, Any]:
    """Open ``url`` in the user's default *visible* browser (not headless).

    This launches the OS default browser window — use the headless
    ``browser_open`` tool instead for background page inspection.
    """
    import webbrowser
    webbrowser.open(url)
    return {"url": url, "status": "opened"}
