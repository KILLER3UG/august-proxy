"""Circuit workbench tool registrations (gated behind /circuit mode).

The model only sees — and may only call — these tools while the session's
circuit workbench is active. ``/circuit on`` (or a plain ``/circuit``
mention) flips the gate on and pops the Circuit panel into the right
drawer; ``/circuit off`` closes it.
"""

from __future__ import annotations

import json

from app.services import tool_registry
from app.services.tools import circuit_tools


def _session() -> object | None:
    from app.services.workbench.context import currentSessionId
    from app.services.workbench.sessions import get_workbench_session

    sid = currentSessionId.get()
    if not sid or sid == 'default':
        return None
    return get_workbench_session(sid)


def _ws() -> str:
    sess = _session()
    return str(getattr(sess, 'workspacePath', '') or '') if sess else ''


def _err(exc: Exception) -> str:
    return f'Error: {exc}'


async def _createNetlist(path: str = '', content: str = '') -> str:
    try:
        return json.dumps(circuit_tools.create_netlist(path, content, _ws()))
    except Exception as exc:
        return _err(exc)


async def _readNetlist(path: str = '') -> str:
    try:
        return json.dumps(circuit_tools.read_netlist(path, _ws()))
    except Exception as exc:
        return _err(exc)


async def _updateNetlist(path: str = '', find: str = '', replace: str = '') -> str:
    try:
        return json.dumps(circuit_tools.update_netlist(path, find, replace, _ws()))
    except Exception as exc:
        return _err(exc)


async def _deleteNetlist(path: str = '') -> str:
    try:
        return json.dumps(circuit_tools.delete_netlist(path, _ws()))
    except Exception as exc:
        return _err(exc)


async def _listNetlists() -> str:
    return json.dumps(circuit_tools.list_netlists(_ws()))


async def _simulate(netlist: str = '', name: str = 'sim') -> str:
    try:
        result = await circuit_tools.simulate_circuit(
            netlist, name=name, workspace=_ws(), session=_session(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _searchComponent(query: str = '') -> str:
    try:
        result = await circuit_tools.search_component(query)
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _listBoards(family: str = '') -> str:
    try:
        return json.dumps(await circuit_tools.list_boards(family))
    except Exception as exc:
        return _err(exc)


async def _integrateComponent(query: str = '') -> str:
    try:
        result = await circuit_tools.integrate_component(query)
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _render3d(path: str = '', netlistOrPath: str = '', width: float = 60,
                    height: float = 45, elevation: float = 28) -> str:
    try:
        result = circuit_tools.render_board_3d(
            path, netlistOrPath,
            width=float(width), height=float(height), elevation=float(elevation),
            workspace=_ws(), session=_session(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


# ── /circuit command handling (called from the workbench turn loop) ────────

CIRCUIT_MODE_HINT = (
    'Circuit workbench is ACTIVE for this chat. You now have circuit tools '
    '(netlist create/read/update/delete/list, simulate_circuit, '
    'search_component, render_board_3d). Use SPICE netlists; simulate with '
    '.op/.dc/.tran/.ac cards; render_board_3d writes a PNG the user sees in '
    'the right-hand Circuit panel.'
)


def handle_circuit_command(session: object, arg: str) -> dict[str, object]:
    """Apply ``/circuit [on|off]`` to the session. Returns an SSE-style ack."""
    a = (arg or '').strip().lower()
    if a in ('off', 'exit', 'close', 'stop'):
        circuit_tools.set_circuit_mode(session, False)
        return {'circuitMode': False, 'notice': 'Circuit workbench closed.'}
    # Bare /circuit, "on", or any other text turns it on.
    circuit_tools.set_circuit_mode(session, True)
    return {
        'circuitMode': True,
        'notice': 'Circuit workbench opened — netlists, ngspice simulation, component search, and 3D board view are now available.',
        'systemHint': CIRCUIT_MODE_HINT,
    }


def maybe_intercept_circuit(session: object, text: str) -> dict[str, object] | None:
    """If the user message is a /circuit command, apply it and return an
    interception payload; None lets the message flow normally."""
    t = (text or '').strip()
    if not t.lower().startswith('/circuit'):
        return None
    rest = t[len('/circuit'):].strip()
    payload = handle_circuit_command(session, rest)
    payload['intercepted'] = True
    return payload


def filter_circuit_tools(
    tools: list[dict[str, object]], session: object | None
) -> list[dict[str, object]]:
    """Drop circuit tools when circuit mode is off (tool catalog filter)."""
    if session is not None and circuit_tools.is_circuit_mode(session):
        return tools
    return [t for t in tools if not str(t.get('name', '')).startswith('circuit_')]


def register() -> None:
    """Register the gated circuit tools."""
    tool_registry.register(
        'circuit_create_netlist',
        'Create a SPICE netlist file (.cir/.net/.ckt/.sp) in the workspace. '
        'content is raw SPICE text (first line becomes the title comment; '
        '.end appended if missing).',
        _createNetlist,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string'},
                'content': {'type': 'string', 'description': 'Raw SPICE netlist'},
            },
            'required': ['path', 'content'],
        },
    )
    tool_registry.register(
        'circuit_read_netlist',
        'Read a netlist file and list its components (name, type letter, nodes, value).',
        _readNetlist,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'circuit_update_netlist',
        'Edit one occurrence in a netlist file (find → replace). Re-read after editing.',
        _updateNetlist,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string'},
                'find': {'type': 'string'},
                'replace': {'type': 'string'},
            },
            'required': ['path', 'find', 'replace'],
        },
    )
    tool_registry.register(
        'circuit_delete_netlist',
        'Delete a netlist file from the workspace.',
        _deleteNetlist,
        {
            'type': 'object',
            'properties': {'path': {'type': 'string'}},
            'required': ['path'],
        },
    )
    tool_registry.register(
        'circuit_list_netlists',
        'List every netlist file in the workspace.',
        lambda: _listNetlists(),
        {'type': 'object', 'properties': {}},
    )
    tool_registry.register(
        'circuit_simulate',
        'Run an ngspice simulation — inline netlist text OR a workspace '
        'netlist path. Supports .op (DC operating point), .dc sweep, .tran '
        '(time domain), .ac (frequency). Returns parsed measures (node '
        'voltages/currents), errors, and the log tail. Same SPICE engine '
        'Kicad uses; behaves like physical bench measurements.',
        _simulate,
        {
            'type': 'object',
            'properties': {
                'netlist': {'type': 'string', 'description': 'Inline SPICE text or file path'},
                'name': {'type': 'string', 'description': 'Saved deck basename for inline decks'},
            },
            'required': ['netlist'],
        },
    )
    tool_registry.register(
        'circuit_search_component',
        'Look up a part (LM7805, NE555, 1N4007...): offline datasheet facts '
        'plus live web datasheet links.',
        _searchComponent,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string'}},
            'required': ['query'],
        },
    )
    tool_registry.register(
        'circuit_list_boards',
        'List known dev boards with datasheet specs (Arduino families UNO '
        'through Giga, ESP8266/every ESP32 variant, Raspberry Pi Pico/SBC '
        'line). Filter by family substring, e.g. "esp32" or "pico".',
        _listBoards,
        {
            'type': 'object',
            'properties': {'family': {'type': 'string', 'description': 'Optional filter'}},
        },
    )
    tool_registry.register(
        'circuit_integrate_component',
        'Search-and-integrate a part or board: returns datasheet facts, '
        'ready-to-paste SPICE model cards for classics (1N4148/1N4007/'
        '2N2222/2N3904...), board specs for Arduino/ESP/Raspberry Pi, and '
        'web datasheet links. Use this BEFORE designing with an unfamiliar '
        'part so the netlist uses real electrical parameters.',
        _integrateComponent,
        {
            'type': 'object',
            'properties': {'query': {'type': 'string', 'description': 'Part number or board name'}},
            'required': ['query'],
        },
    )
    tool_registry.register(
        'circuit_render_3d',
        'Render a KiCad-style 3D board preview PNG from a netlist (inline '
        'text or workspace path). Components appear as labeled bodies on a '
        'PCB substrate. The image shows up in the right-hand Circuit panel.',
        _render3d,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Output PNG path'},
                'netlistOrPath': {'type': 'string'},
                'width': {'type': 'number', 'description': 'Board mm width'},
                'height': {'type': 'number', 'description': 'Board mm depth'},
                'elevation': {'type': 'number', 'description': 'Camera elevation degrees'},
            },
            'required': ['path', 'netlistOrPath'],
        },
    )
