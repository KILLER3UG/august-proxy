"""
Tool registry — register, describe, and dispatch tools (Phase 3).

Supports reserved bridge names and optional keywords per tool.
"""

from __future__ import annotations

import contextvars
import logging
from typing import Callable, Coroutine

logger = logging.getLogger(__name__)

_registry: dict[str, dict[str, object]] = {}
ToolHandler = Callable[..., Coroutine[object, object, str]]
# Bridge tool names (tool_search / tool_describe / tool_call) are REGISTERED
# with real handlers in tool_bridges now — the set is empty so registration
# works; the names are documented in tool_bridges for def assembly.
_RESERVEDNames: frozenset[str] = frozenset()
_daemonContext: contextvars.ContextVar[bool] = contextvars.ContextVar('daemon_context', default=False)
# Monotonic generation for tool-definition caches (increments on register/clear).
_generation: int = 0


def setDaemonContext(*, pollInterval: int = 30) -> None:
    """v2: Mark subsequent tool calls as coming from a daemon.

    While set, the workbench treats calls as unattended (no approval prompts).
    The `poll_interval` is recorded for use in adaptive TTL (Phase 10.1).
    """
    _daemonContext.set(True)


def clearDaemonContext() -> None:
    """v2: Exit daemon context."""
    _daemonContext.set(False)


def isDaemonContext() -> bool:
    """v2: Check if currently in daemon context."""
    return _daemonContext.get()


def register(
    name: str,
    description: str,
    handler: ToolHandler,
    parameters: dict[str, object] | None = None,
    keywords: list[str] | None = None,
) -> None:
    """Register a tool.

    ``keywords`` is an optional list of search terms for BM25 retrieval (Phase 3).
    """
    global _generation
    if name in _RESERVEDNames:
        raise ValueError(f"Cannot register reserved bridge name: '{name}'")
    _registry[name] = {
        'name': name,
        'description': description,
        'handler': handler,
        'parameters': parameters or {},
        'keywords': keywords or [],
    }
    _generation += 1


def generation() -> int:
    """Monotonic counter bumped on each register/unregister.

    Tool-definition caches key on this so they rebuild after the registry changes.
    """
    return _generation


def unregister(name: str) -> bool:
    """Remove a registered tool. Returns True if it was present.

    Bumps ``generation()`` so tool-definition caches drop entries for withdrawn
    tools and stop serving stale schemas.
    """
    global _generation
    if name not in _registry:
        return False
    del _registry[name]
    _generation += 1
    return True


def get(name: str) -> dict[str, object] | None:
    """Get a tool definition by name."""
    return _registry.get(name)


def getTool(name: str) -> dict[str, object] | None:
    """Alias for get()."""
    return _registry.get(name)


def listRaw() -> list[dict[str, object]]:
    """List all registered tools in raw (internal) format with keywords."""
    return list(_registry.values())


_DESKTOP_TOOL_PREFIXES = (
    'desktop_',
    'computer_',
    'host_',
)


def is_host_agent_tool(name: str) -> bool:
    """Tools that require a reachable host agent / local desktop automation."""
    if not isinstance(name, str):
        return False
    return name.startswith(_DESKTOP_TOOL_PREFIXES) or name in (
        'screenshot',
        'computer_use',
        'move_mouse',
        'click_mouse',
        'type_text',
    )


async def host_agent_available() -> bool:
    """True when host agent URL is set and health responds, or local desktop is usable."""
    import os

    url = os.environ.get('AUGUST_HOST_AGENT_URL', '').strip()
    if url:
        try:
            from app.services.host_agent import getHostInfo

            info = await getHostInfo()
            return bool(info.get('available'))
        except Exception:
            return False
    # Local pyautogui path: available when import works (desktop_automation)
    try:
        import app.services.desktop_automation as da  # noqa: F401

        return True
    except Exception:
        return False


def listTools(*, include_host_agent: bool | None = None) -> list[dict[str, object]]:
    """List tools; hide host/desktop tools when host agent is unavailable.

    ``include_host_agent``:
      - None: best-effort sync check (env URL unset → keep local desktop tools)
      - True/False: force include/exclude
    """
    show_host = include_host_agent
    if show_host is None:
        import os

        url = os.environ.get('AUGUST_HOST_AGENT_URL', '').strip()
        # When URL is set but we can't async-check here, hide until proven up
        # (callers that need async should pass include_host_agent after await).
        if url:
            show_host = False
        else:
            show_host = True  # local desktop path
    result: list[dict[str, object]] = []
    for t in _registry.values():
        name = t.get('name')
        if not isinstance(name, str):
            continue
        if not show_host and is_host_agent_tool(name):
            continue
        description = t.get('description')
        parameters = t.get('parameters')
        if not isinstance(description, str):
            description = ''
        if not isinstance(parameters, dict):
            parameters = {}
        result.append(
            {'type': 'function', 'function': {'name': name, 'description': description, 'parameters': parameters}}
        )
    return result


def schema_param_hint(tool: dict[str, object]) -> str:
    """Render a tool's registered JSON-schema parameters as a compact
    ``name:type`` list (required params starred) for error receipts."""
    params = tool.get('parameters')
    if not isinstance(params, dict):
        return ''
    props = params.get('properties')
    if not isinstance(props, dict):
        return ''
    required = params.get('required')
    requiredSet = {str(r) for r in required} if isinstance(required, list) else set()
    parts: list[str] = []
    for key, spec in props.items():
        typ = spec.get('type') if isinstance(spec, dict) else None
        label = f'{key}:{typ}' if typ else str(key)
        if str(key) in requiredSet:
            label += '*'
        parts.append(label)
    return ', '.join(parts)


# Argument-shape mistakes surface deep in handlers as these — the raw text
# ('str' object has no attribute 'get') tells the model nothing, so we swap
# it for a schema-aware receipt. Anything else (OSError, ValueError from
# real logic) keeps its message — it is genuinely informative.
ARG_SHAPE_EXCEPTIONS = (TypeError, AttributeError, KeyError, IndexError)


async def dispatch(name: str, args: dict[str, object]) -> str:
    """Dispatch a tool call by name and arguments.

    Host/desktop tools refuse when the host agent is configured but down.
    """
    tool = _registry.get(name)
    if not tool:
        return f'Error: Tool "{name}" not found.'
    if is_host_agent_tool(name):
        import os

        if os.environ.get('AUGUST_HOST_AGENT_URL', '').strip():
            if not await host_agent_available():
                return (
                    f'[UNAVAILABLE] Tool "{name}" requires the host agent, '
                    'which is disconnected. Set AUGUST_HOST_AGENT_URL to a healthy '
                    'agent or clear it to use local desktop automation.'
                )
    # (Daemon run_command blocklist removed 2026-09-09: setDaemonContext had
    # no callers in-repo, so the gate could never fire. The contextvar trio
    # stays — the workbench _unattended check reads it — and re-adding a
    # daemon command gate belongs with an actual daemon tool-execution path.)
    try:
        handler = tool['handler']
        if not callable(handler):
            return f'Error: Tool "{name}" handler is not callable.'
        result = await handler(**args)
        # Safety net: the tool-result pipeline (SSE, history, model context)
        # requires a string. A handler that returns dict/list (the camera
        # tools did) must not smuggle a non-str into the transcript.
        if not isinstance(result, str):
            import json

            try:
                result = json.dumps(result, ensure_ascii=False, default=str)
            except (TypeError, ValueError):
                result = str(result)
        return result
    except ARG_SHAPE_EXCEPTIONS as e:
        # The handler choked on the argument shape — hand the model a
        # schema-aware receipt instead of a raw Python message it cannot
        # act on (the old text made models flail through retry spirals).
        logger.warning('tool %s argument-shape failure', name, exc_info=True)
        hint = schema_param_hint(tool)
        suffix = f' Expected parameters: {hint}.' if hint else ''
        return (
            f'Error executing {name}: the arguments did not match this tool\'s schema '
            f'({type(e).__name__}). Pass arrays as arrays and objects as objects — '
            f'never stringified JSON. Required shape: {name}({hint or "see tool definition"}).{suffix}'
        )
    except Exception as e:
        return f'Error executing {name}: {e}'
