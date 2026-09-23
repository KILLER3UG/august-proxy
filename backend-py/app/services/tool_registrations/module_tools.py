"""`module_context` tool — bounded reading package for a file or directory.

Registered separately from the engine (`app.services/workbench/module_context.py`)
so the engine stays callable from prompt assembly and testable without the
tool registry.
"""

from __future__ import annotations

import asyncio

from app.json_narrowing import as_int, as_str
from app.services import tool_registry
from app.services.tool_registrations.file_tools import _workspace
from app.services.workbench.module_context import MAX_CONTEXT_CHARS, build_module_context


async def _moduleContext(path: str = '', maxChars: int = 0) -> str:
    target = as_str(path, '').strip()
    if not target:
        return (
            'Error: path is required — a file or directory inside the workspace, '
            'e.g. "backend-py/app/services/tool_registry.py" or "frontend/desktop/src/store".'
        )
    limit = as_int(maxChars, 0) or MAX_CONTEXT_CHARS
    workspace = _workspace()
    # The reverse-dependency scan walks and reads source files for up to its
    # time budget; on the event loop that would stall every other stream.
    return await asyncio.to_thread(build_module_context, workspace, target, limit)


def register() -> None:
    """Register the module-context tool."""
    tool_registry.register(
        'module_context',
        (
            'Summarize one file or directory within a fixed budget: its purpose, exported '
            'names and signatures, what it imports, and which files import it. Use this '
            'BEFORE read_file when deciding which file to open, when approaching an '
            'unfamiliar module, or when you need a module\'s API surface without its body — '
            'it costs a fraction of reading the file. Read a directory first, then the '
            'specific file you need. Truncated sections say so; an "Imported by" list may '
            'be a subset.'
        ),
        _moduleContext,
        {
            'type': 'object',
            'properties': {
                'path': {
                    'type': 'string',
                    'description': 'File or directory to describe, relative to the workspace root (or absolute inside it).',
                },
                'maxChars': {
                    'type': 'integer',
                    'description': f'Hard cap on the returned block. Default {MAX_CONTEXT_CHARS}.',
                },
            },
            'required': ['path'],
        },
    )
