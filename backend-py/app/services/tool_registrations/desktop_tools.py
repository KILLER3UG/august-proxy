"""Desktop automation tool registration (handlers live in desktop_automation)."""

from __future__ import annotations

from typing import cast

from app.services import desktop_automation as _desktop
from app.services import tool_registry


def register() -> None:
    """Register desktop automation tools."""
    tool_registry.register(
        'desktop_screenshot',
        'Capture the real desktop screen as a base64-encoded PNG image.',
        cast(tool_registry.ToolHandler, _desktop.takeScreenshot),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_screen_size',
        'Return the real screen dimensions in pixels.',
        cast(tool_registry.ToolHandler, _desktop.getScreenSize),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_mouse_position',
        'Return the current real cursor (x, y) position.',
        cast(tool_registry.ToolHandler, _desktop.getMousePosition),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_click',
        'Move the real mouse to (x, y) and click. button: left|right|middle.',
        cast(tool_registry.ToolHandler, _desktop.clickMouse),
        {
            'type': 'object',
            'properties': {
                'x': {'type': 'integer', 'description': 'Screen X coordinate.'},
                'y': {'type': 'integer', 'description': 'Screen Y coordinate.'},
                'button': {
                    'type': 'string',
                    'enum': ['left', 'right', 'middle'],
                    'description': 'Mouse button (default left).',
                },
            },
            'required': ['x', 'y'],
        },
    )
    tool_registry.register(
        'desktop_type',
        'Type text on the real keyboard.',
        cast(tool_registry.ToolHandler, _desktop.typeText),
        {
            'type': 'object',
            'properties': {'text': {'type': 'string', 'description': 'The text to type.'}},
            'required': ['text'],
        },
    )
    tool_registry.register(
        'desktop_press_key',
        'Press a single real keyboard key (e.g. enter, escape, tab, f1).',
        cast(tool_registry.ToolHandler, _desktop.pressKey),
        {
            'type': 'object',
            'properties': {'key': {'type': 'string', 'description': "Key name (e.g. 'enter', 'escape')."}},
            'required': ['key'],
        },
    )
    tool_registry.register(
        'desktop_list_windows',
        'List visible desktop windows with title and position (x, y, width, height).',
        cast(tool_registry.ToolHandler, _desktop.listWindows),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'desktop_open_url',
        "Open a URL in the user's default *visible* browser (not headless). Use browser_open instead for background page inspection.",
        cast(tool_registry.ToolHandler, _desktop.openUrl),
        {
            'type': 'object',
            'properties': {'url': {'type': 'string', 'description': 'The URL to open.'}},
            'required': ['url'],
        },
    )

    async def _cameraListDevices(**kwargs: object) -> dict[str, object]:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = getRuntimeConfig()
        if not bool(cfg.get('cameraAccess')):
            return {
                'error': 'Camera access is disabled. Enable it in Settings → Computer Access → Camera to use the camera tools.',
            }
        return _desktop.listCameraDevices()

    async def _cameraSnapshot(
        device: str = '',
        question: str = '',
        **kwargs: object,
    ) -> dict[str, object]:
        from app.services.brain_config_service import getRuntimeConfig

        cfg = getRuntimeConfig()
        if not bool(cfg.get('cameraAccess')):
            return {
                'error': 'Camera access is disabled. Enable it in Settings → Computer Access → Camera to use the camera tools.',
            }
        return await _desktop.captureCameraFrame(device=device, question=question)

    tool_registry.register(
        'camera_list_devices',
        'List available webcam devices on this machine. Returns {devices:[{name,kind}]}. '
        'Gated by the Camera toggle in Settings → Computer Access (off by default).',
        cast(tool_registry.ToolHandler, _cameraListDevices),
        {'type': 'object', 'properties': {}, 'required': []},
    )
    tool_registry.register(
        'camera_snapshot',
        'Grab one webcam frame, describe it via the vision model, and discard the raw frame '
        'immediately. Frames are TRANSIENT — never persisted to disk, memory stores, or the '
        'observation gallery. Pass device=<name> from camera_list_devices (omit = first device).',
        cast(tool_registry.ToolHandler, _cameraSnapshot),
        {
            'type': 'object',
            'properties': {
                'device': {
                    'type': 'string',
                    'description': 'DirectShow device name (from camera_list_devices). Empty = first device.',
                },
                'question': {
                    'type': 'string',
                    'description': 'What to look for / ask the vision model about the frame.',
                },
            },
            'required': [],
        },
    )
