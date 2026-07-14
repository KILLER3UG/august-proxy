"""Desktop automation tool registration (handlers live in desktop_automation)."""

from __future__ import annotations
from typing import cast
from app.services import tool_registry
from app.services import desktop_automation as _desktop


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
