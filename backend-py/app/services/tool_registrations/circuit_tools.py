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


async def _simulate(netlist: str = '', name: str = 'sim', traces=None, sweep=None) -> str:
    try:
        result = await circuit_tools.simulate_circuit(
            netlist, name=name, workspace=_ws(), session=_session(),
            traces=traces, sweep=sweep,
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _circuitTest(netlist: str = '', assertions=None, name: str = 'test') -> str:
    try:
        result = await circuit_tools.circuit_test(
            netlist, assertions, name=name, workspace=_ws(), session=_session(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _injectFault(netlist: str = '', ref: str = '', fault: str = '',
                       percent=None) -> str:
    try:
        return json.dumps(circuit_tools.inject_fault(netlist, ref, fault, percent))
    except Exception as exc:
        return _err(exc)


async def _exportVcd(netlist: str = '', signals=None, name: str = 'digital') -> str:
    try:
        result = await circuit_tools.circuit_export_vcd(
            netlist, signals=signals, name=name,
            workspace=_ws(), session=_session(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _symbolic(netlist: str = '', node: str = '', ref: str = '') -> str:
    try:
        return json.dumps(circuit_tools.circuit_symbolic(netlist, node, ref))
    except Exception as exc:
        return _err(exc)


async def _annotate(netlist: str = '', name: str = 'op') -> str:
    try:
        result = await circuit_tools.circuit_annotate(
            netlist, name=name, workspace=_ws(), session=_session(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _lintDiagram(diagram: str = '') -> str:
    try:
        return json.dumps(circuit_tools.circuit_lint_diagram(diagram))
    except Exception as exc:
        return _err(exc)


async def _hdlLint(source: str = '') -> str:
    try:
        from app.services.tools import hdl_tools

        return json.dumps(await hdl_tools.hdl_lint(
            source, workspace=_ws(), session=_session()))
    except Exception as exc:
        return _err(exc)


async def _hdlSimulate(source: str = '', top: str = '', name: str = 'sim') -> str:
    try:
        from app.services.tools import hdl_tools

        return json.dumps(await hdl_tools.hdl_simulate(
            source, top=top, name=name, workspace=_ws(), session=_session()))
    except Exception as exc:
        return _err(exc)


async def _vcdParse(path: str = '', at=None, signal: str = '') -> str:
    try:
        from app.services.tools import hdl_tools

        return json.dumps(hdl_tools.vcd_parse(
            path, at=at, signal=signal, workspace=_ws(), session=_session()))
    except Exception as exc:
        return _err(exc)


async def _hdlTest(module: str = '', sources=None, top: str = '', name: str = 'hdltest') -> str:
    try:
        from app.services.tools import hdl_tools

        return json.dumps(await hdl_tools.hdl_test(
            module, sources=sources, top=top, name=name,
            workspace=_ws(), session=_session()))
    except Exception as exc:
        return _err(exc)


async def _hdlTimingDiagram(wavejson='', name: str = 'timing') -> str:
    try:
        from app.services.tools import hdl_tools

        result = await hdl_tools.hdl_timing_diagram(
            wavejson, name=name, workspace=_ws(), session=_session())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _fpgaCompile(
    source: str = '',
    name: str = 'fpga',
    device: str = 'EP4CE6E22C6',
    top: str = '',
    pins=None,
) -> str:
    try:
        from app.services.tools import fpga_tools

        result = await fpga_tools.fpga_compile(
            source, name=name, device=device, top=top, pins=pins,
            workspace=_ws(), session=_session())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _kicadChecks(sch: str = '', pcb: str = '') -> str:
    try:
        from app.services.tools import kicad_tools

        result = await kicad_tools.kicad_checks(
            sch, pcb, workspace=_ws(), session=_session())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _kicadRender(pcb: str = '', format: str = 'png', name: str = 'board') -> str:
    try:
        from app.services.tools import kicad_tools

        result = await kicad_tools.kicad_render(
            pcb, format=format, name=name,
            workspace=_ws(), session=_session())
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _firmwareCompile(source: str = '', name: str = 'firmware', board: str = 'uno') -> str:
    try:
        from app.services.tools import firmware_tools

        result = await firmware_tools.firmware_compile(
            source, name=name, board=board,
            workspace=_ws(), session=_session(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _firmwareRun(
    hex: str = '',
    ms: object = None,
    expect=None,
    fail=None,
    pins=None,
    timeline: str = '',
) -> str:
    try:
        from app.services.tools import firmware_tools

        result = await firmware_tools.firmware_run(
            hex, ms=ms, expect=expect, fail=fail, pins=pins,
            timeline=timeline, workspace=_ws(), session=_session(),
        )
        return json.dumps(result)
    except Exception as exc:
        return _err(exc)


async def _firmwareStimulus(
    timeline: str = '',
    netlist: str = '',
    pins=None,
    board: str = 'uno',
    name: str = 'stim',
) -> str:
    try:
        from app.services.tools import firmware_tools

        result = firmware_tools.firmware_stimulus(
            timeline, netlist=netlist, pins=pins, board=board, name=name,
            workspace=_ws(), session=_session(),
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


async def _env() -> str:
    try:
        return json.dumps(await circuit_tools.circuit_env())
    except Exception as exc:
        return _err(exc)


# ── /circuit command handling (called from the workbench turn loop) ────────

CIRCUIT_MODE_HINT = (
    'Circuit workbench is ACTIVE for this chat. You now have circuit tools '
    '(netlist create/read/update/delete/list, circuit_simulate, circuit_test, '
    'circuit_inject_fault, circuit_export_vcd, circuit_symbolic, '
    'circuit_annotate, circuit_lint_diagram, firmware_compile, firmware_run, '
    'firmware_stimulus, hdl_lint, hdl_simulate, vcd_parse, hdl_test, '
    'hdl_timing_diagram, fpga_compile, kicad_checks, kicad_render, '
    'circuit_search_component, circuit_render_3d, circuit_env). Use SPICE netlists; '
    'simulate with .op/.dc/.tran/.ac cards; verify designs with circuit_test '
    'assertions ({measure, expect, tolerance} or {measure, min, max}); '
    'fault decks with circuit_inject_fault (open/short/drift) for '
    'troubleshooting exercises; '
    'circuit_export_vcd dumps digital (.tran + XSPICE) node waveforms to a '
    'workspace .vcd logic-analyzer file; '
    'circuit_symbolic derives H(s), poles/zeros, and V(t) to explain and '
    'cross-check simulated numbers; '
    'circuit_annotate draws the .op overlay — nodes voltage-colored '
    '(blue→red) with branch currents as a workspace SVG; '
    'circuit_lint_diagram validates a diagram.json breadboard-wiring '
    'artifact (parts + "part:pin" connections) before use — netlists '
    'stay the SPICE source of truth, the diagram describes wiring '
    'around the MCU and pins the co-sim mapping; '
    'firmware_compile builds Arduino/C firmware to a HEX for emulated '
    'runs (board=uno/nano/mega/...); firmware_run emulates that HEX and '
    'returns the serial monitor capture, GPIO state, expect/fail serial '
    'assertions, and a pin-edge timeline (timeline=<name>) that seeds PWL '
    'stimulus for ngspice decks; firmware_stimulus converts that '
    '<name>_pins.json timeline into ngspice PWL sources (Vp<pin> N<pin> '
    '0 PWL(...)) and can inject them into a deck — the firmware→SPICE '
    'bridge for PWM-into-RC-filter style mixed-signal runs; '
    'hdl_lint checks VHDL/Verilog syntax instantly (ghdl/verilator, '
    'file:line diagnostics); hdl_simulate runs HDL testbenches and '
    'persists the .vcd waveform for the Circuit panel; vcd_parse reads '
    'any VCD — signal activity, value-at-time queries, and UART '
    'protocol decode (baud auto-detected, 8N1); hdl_test runs cocotb '
    'Python testbenches with a JUnit XML verdict; hdl_timing_diagram '
    'renders WaveDrom WaveJSON to a timing-diagram SVG; fpga_compile '
    'runs the Quartus flow (map→fit→asm→sta) on your HDL — pin map via '
    'pins={signal: PIN_xx}, reports parsed to logic-elements/registers/'
    'fmax, .sof copied to the workspace; kicad_checks runs ERC/DRC on '
    'real .kicad_sch/.kicad_pcb designs (agent-verifiable gates); '
    'kicad_render makes real-board PNG/GLB visuals from a .kicad_pcb; '
    'circuit_render_3d writes a PNG '
    'the user sees in the right-hand Circuit panel; circuit_env tells you '
    'which EDA engines (ngspice/HDL/FPGA/KiCad/arduino-cli) are installed.'
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
    return [t for t in tools if not _is_circuit_gate_tool(str(t.get('name', '')))]


def _is_circuit_gate_tool(name: str) -> bool:
    """Names the /circuit gate owns. circuit_* plus the Phase-3/4/5 firmware,
    HDL, VCD, FPGA, and KiCad tools — they all belong to the circuit
    workbench."""
    return (
        name.startswith('circuit_')
        or name.startswith('firmware_')
        or name.startswith('hdl_')
        or name in ('vcd_parse', 'fpga_compile', 'fpga_program',
                    'kicad_checks', 'kicad_render')
    )


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
        'Run an ngspice simulation — inline netlist text OR a workspace netlist path. Supports .op (DC '
        'operating point), .dc sweep, .tran (time domain), .ac (frequency). Returns parsed measures '
        '(node voltages/currents), errors, and log tail. Pass traces (a list of waveform expressions '
        'like ["v(out)", "i(r1)", "vdb(out)"]) on .tran/.ac/.dc runs to also get downsampled x/y '
        'waveforms back plus a tracesFile that render_chart (kind=line) plots directly. '
        'Pass sweep {"param","from","to","steps"} to re-run the deck once per parameter value '
        '(reference it in the netlist as {param}); per-step measures come back as sweepResults. '
        'Same SPICE engine KiCad uses.',
        _simulate,
        {
            'type': 'object',
            'properties': {
                'netlist': {'type': 'string', 'description': 'Inline SPICE text or file path'},
                'name': {'type': 'string', 'description': 'Saved deck basename for inline decks'},
                'traces': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Waveform expressions to sample on .tran/.ac/.dc runs, '
                    'e.g. ["v(out)", "i(r1)", "vdb(out)"] — max 8, each downsampled to ≤2000 points',
                },
                'sweep': {
                    'type': 'object',
                    'description': 'Parametric sweep {param, from, to, steps}; the netlist must '
                    'reference the value as {param}. Returns sweepResults=[{paramValue, measures}]',
                },
            },
            'required': ['netlist'],
        },
    )
    tool_registry.register(
        'circuit_test',
        'Run a netlist once and grade assertions over its measures — the design→assert→fix '
        'self-verification loop with a machine-readable verdict. Each assertion is '
        '{measure, expect, tolerance} (relative; absolute when expect=0) or {measure, min, max}. '
        'Returns {passed, results:[{name, value, expect, ok, note}]} plus the measures for fixing failures.',
        _circuitTest,
        {
            'type': 'object',
            'properties': {
                'netlist': {'type': 'string', 'description': 'Inline SPICE text or file path'},
                'assertions': {
                    'type': 'array',
                    'items': {'type': 'object'},
                    'description': '[{measure, expect, tolerance} | {measure, min, max}, ...]',
                },
                'name': {'type': 'string', 'description': 'Saved deck basename for inline decks'},
            },
            'required': ['netlist', 'assertions'],
        },
    )
    tool_registry.register(
        'circuit_inject_fault',
        'Fault a SPICE deck for troubleshooting exercises (Multisim-Education style). Given deck '
        'text, a part ref, and fault=open|short|drift, returns the faulted variant deck as text: '
        'open removes the part, short replaces it with a 1 mΩ resistor across its first two nodes, '
        'drift scales its value by percent (R/C/L only, e.g. percent=20 or -30). Pure text '
        'transform — then simulate the variant with circuit_simulate/circuit_test and compare '
        'measures against the healthy deck. If the deck lives in a file, circuit_read_netlist it first.',
        _injectFault,
        {
            'type': 'object',
            'properties': {
                'netlist': {'type': 'string', 'description': 'SPICE deck text (the healthy circuit)'},
                'ref': {'type': 'string', 'description': 'Part reference to fault, e.g. R1, C2, Q1'},
                'fault': {
                    'type': 'string',
                    'enum': ['open', 'short', 'drift'],
                    'description': 'open = remove part; short = 1 mΩ across it; drift = scale value',
                },
                'percent': {
                    'type': 'number',
                    'description': 'Required for drift: value change in percent (20 = +20%, -30 = −30%)',
                },
            },
            'required': ['netlist', 'ref', 'fault'],
        },
    )
    tool_registry.register(
        'circuit_export_vcd',
        'Export digital-node waveforms from a .tran deck as a VCD file (ngspice eprvcd) — the '
        'logic-analyzer artifact for XSPICE runs (74xx cards, NE555 macro). Returns the workspace '
        'vcdFile path plus a summary (signals, timescale, duration, valueChanges). Omit signals to '
        'auto-discover and export every event node; analog nodes/expressions may be included — '
        'they are sampled at event times. The deck must contain a .tran card.',
        _exportVcd,
        {
            'type': 'object',
            'properties': {
                'netlist': {'type': 'string', 'description': 'Inline SPICE text or workspace deck path'},
                'signals': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Event (digital) node names to export; omit to export all of them',
                },
                'name': {'type': 'string', 'description': 'Basename for the .vcd artifact (default "digital")'},
            },
            'required': ['netlist'],
        },
    )
    tool_registry.register(
        'circuit_symbolic',
        'Symbolic analysis of a linear circuit (lcapy): transfer function H(s) = V(node)/V(source) '
        'simplified + LaTeX, its poles and zeros, and the exact V(t) step response. Use it to '
        'EXPLAIN a circuit (why the cutoff is where it is) and to CROSS-CHECK ngspice numbers '
        '(symbolic −3 dB point vs simulated). Sources with dc/pulse/sin values are treated as '
        'steps of the same amplitude; write "V1 1 0 step 5" for explicit Laplace sources. '
        'Requires the optional lcapy dependency (uv sync --extra eda) — returns install '
        'guidance when absent.',
        _symbolic,
        {
            'type': 'object',
            'properties': {
                'netlist': {'type': 'string', 'description': 'Inline SPICE text (linear circuit)'},
                'node': {'type': 'string', 'description': 'Output node for H(s)/V(t); default = highest-numbered node'},
                'ref': {'type': 'string', 'description': 'Source ref for H(s) when several exist (e.g. V1)'},
            },
            'required': ['netlist'],
        },
    )
    tool_registry.register(
        'circuit_annotate',
        'Operating-point overlay: run .op on a deck and draw a voltage-colored '
        'schematic SVG (blue = low, red = high — the Falstad convention) with '
        'branch currents annotated per element. The file lands in the workspace '
        'as <name>.op.svg and appears in the right-drawer Circuit panel. Great '
        'for explaining bias points and verifying a divider/bias network at a '
        'glance. Requires ngspice (circuit_env).',
        _annotate,
        {
            'type': 'object',
            'properties': {
                'netlist': {'type': 'string', 'description': 'Inline SPICE text or workspace deck path'},
                'name': {'type': 'string', 'description': 'Basename for the .op.svg artifact (default "op")'},
            },
            'required': ['netlist'],
        },
    )
    tool_registry.register(
        'circuit_lint_diagram',
        'Validate a diagram.json breadboard-wiring artifact (Wokwi-compatible: '
        'parts + connections + attrs) before using it. Checks part ids/types '
        '(arduino-uno, led, resistor...), that every connection endpoint '
        '"part:pin" resolves to a declared part, the v/h/* wire-routing ops, '
        'and power-rail presence around an MCU. Netlists remain the SPICE '
        'source of truth; the diagram describes breadboard wiring around the '
        'MCU (LED → pin 13) and pins the co-sim mapping.',
        _lintDiagram,
        {
            'type': 'object',
            'properties': {
                'diagram': {
                    'type': 'string',
                    'description': 'diagram.json text OR a workspace .json path',
                },
            },
            'required': ['diagram'],
        },
    )
    tool_registry.register(
        'firmware_compile',
        'Compile microcontroller firmware to a HEX artifact: Arduino sketches '
        '(setup()/loop(), .ino) via arduino-cli, plain C via avr-gcc. board is a '
        'friendly name (uno/nano/mega/leonardo/unor4) or a full FQBN. The hexFile '
        'feeds firmware_run (emulated execution + serial capture) and the pin '
        'timeline → PWL stimulus export into ngspice decks. Returns flash/RAM '
        'usage and the build log tail; install guidance when the toolchain is '
        'missing (circuit_env reports availability).',
        _firmwareCompile,
        {
            'type': 'object',
            'properties': {
                'source': {
                    'type': 'string',
                    'description': 'Inline sketch/C code OR a workspace .ino sketch-folder / .c file path',
                },
                'name': {'type': 'string', 'description': 'Artifact basename (default "firmware")'},
                'board': {'type': 'string', 'description': 'Board: uno, nano, mega, leonardo, unor4, or a full FQBN'},
            },
            'required': ['source'],
        },
    )
    tool_registry.register(
        'firmware_run',
        'Emulate compiled AVR firmware (avr8js): run the firmware_compile HEX for '
        'bounded simulated milliseconds and get the serial monitor capture, final '
        'GPIO state per pin, per-pin toggle counts + edge timeline, and '
        'expect/fail text assertions (wokwi-cli vocabulary) against serial output. '
        'Pass timeline=<name> to persist the pin-edge timeline as <name>_pins.json — '
        'the PWL stimulus seed for driving ngspice decks from firmware behavior '
        '(PWM → RC filter sims). Requires Node (bundled with the desktop app).',
        _firmwareRun,
        {
            'type': 'object',
            'properties': {
                'hex': {
                    'type': 'string',
                    'description': 'Hex artifact path from firmware_compile (or inline Intel-HEX text)',
                },
                'ms': {'type': 'number', 'description': 'Simulated milliseconds to run (default 2000, max 60000)'},
                'expect': {
                    'anyOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}],
                    'description': 'Text that MUST appear in the serial output',
                },
                'fail': {
                    'anyOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}],
                    'description': 'Text that must NOT appear in the serial output',
                },
                'pins': {
                    'anyOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}],
                    'description': 'Arduino pin numbers to sample (e.g. "13" or "5,6,13"); default = all',
                },
                'timeline': {'type': 'string', 'description': 'Persist pin-edge timeline as <name>_pins.json (PWL stimulus seed)'},
            },
            'required': ['hex'],
        },
    )
    tool_registry.register(
        'firmware_stimulus',
        'Convert a firmware_run pin timeline (<name>_pins.json — pass '
        'timeline=<name> to firmware_run) into ngspice PWL sources: each '
        'toggling pin becomes Vp<pin> N<pin> 0 PWL(...) stepping 0 → '
        'logic-level at the real edge times (board=uno 5V / unor4·esp32 3.3V). '
        'Pass netlist (inline SPICE or a deck path) to inject the PWL cards '
        'before the analysis card and save <name>.cir — hand that to '
        'circuit_simulate for firmware-in-the-loop analog runs (e.g. PWM '
        'pin → RC filter .tran). Without netlist it returns the cards for '
        'inspection.',
        _firmwareStimulus,
        {
            'type': 'object',
            'properties': {
                'timeline': {
                    'type': 'string',
                    'description': 'The <name>_pins.json path firmware_run persisted',
                },
                'netlist': {
                    'type': 'string',
                    'description': 'Optional inline SPICE text or workspace deck path to inject the PWL cards into',
                },
                'pins': {
                    'anyOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}],
                    'description': 'Arduino pin numbers to convert (e.g. "13" or "5,6"); default = every pinned timeline entry',
                },
                'board': {'type': 'string', 'description': 'Logic level: uno/nano/mega (5V), unor4/esp32/pico (3.3V)'},
                'name': {'type': 'string', 'description': 'Basename for the merged .cir deck (default "stim")'},
            },
            'required': ['timeline'],
        },
    )
    tool_registry.register(
        'hdl_lint',
        'Instant syntax/semantic check of VHDL (ghdl -a --std=08) or Verilog '
        '(verilator --lint-only -Wall; iverilog -t null fallback) — the HDL '
        'equivalent of netlist lint. Pass inline HDL text or a workspace '
        'file path; language is auto-detected. Diagnostics come back with '
        'file:line, never a raw error wall. Install guidance when the '
        'engine is absent (circuit_env reports availability).',
        _hdlLint,
        {
            'type': 'object',
            'properties': {
                'source': {'type': 'string', 'description': 'Inline VHDL/Verilog text or a workspace file path'},
            },
            'required': ['source'],
        },
    )
    tool_registry.register(
        'hdl_simulate',
        'Simulate an HDL testbench: VHDL via ghdl --elab-run --wave=wave.vcd, '
        'Verilog via iverilog+vvp (60 s timeout). Returns exit status, parsed '
        'assertion/report lines, and — when a waveform was produced — the '
        'waveFile path (workspace .vcd, viewable in the Circuit panel) plus '
        'a vcd_parse summary. The source must be a self-contained testbench '
        'that finishes (assert ... report / $finish).',
        _hdlSimulate,
        {
            'type': 'object',
            'properties': {
                'source': {'type': 'string', 'description': 'Inline testbench HDL text or a workspace file path'},
                'top': {'type': 'string', 'description': 'Top entity/module name (default = file stem)'},
                'name': {'type': 'string', 'description': 'Basename for the .vcd waveform artifact (default "sim")'},
            },
            'required': ['source'],
        },
    )
    tool_registry.register(
        'vcd_parse',
        'Analyze a VCD waveform file (pure Python — no engine needed): signal '
        'list with edge counts and min/max pulse widths, value-at-time queries '
        '(at="2ms" or tick numbers), and protocol hints — UART bytes decoded '
        'from an RX line with baud auto-detected from start-bit spacing (8N1). '
        'Works on both HDL waveforms and circuit_export_vcd SPICE-digital '
        'dumps — the first protocol-analyser slice.',
        _vcdParse,
        {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Workspace .vcd file path'},
                'at': {
                    'anyOf': [
                        {'type': 'string'},
                        {'type': 'number'},
                        {'type': 'array', 'items': {'type': 'string'}},
                    ],
                    'description': 'Value-at-time query: "2ms", "500us", or raw tick numbers (string/array)',
                },
                'signal': {'type': 'string', 'description': 'Signal name for the UART decode hint (e.g. "rx")'},
            },
            'required': ['path'],
        },
    )
    tool_registry.register(
        'hdl_test',
        'Run cocotb Python testbenches against GHDL/Icarus: module is the '
        'testbench .py (inline code or workspace path), sources are the HDL '
        'files under test (inline or paths). Returns a JUnit XML verdict '
        '(pass/fail per test, persisted as <name>.xml) scraped from the '
        'cocotb results table — the biggest quality-of-life upgrade for '
        'AI-driven VHDL verification. Requires cocotb (uv sync --extra eda).',
        _hdlTest,
        {
            'type': 'object',
            'properties': {
                'module': {'type': 'string', 'description': 'cocotb testbench module: inline Python code or a workspace .py path'},
                'sources': {
                    'anyOf': [{'type': 'string'}, {'type': 'array', 'items': {'type': 'string'}}],
                    'description': 'HDL file(s) under test: inline text or workspace paths',
                },
                'top': {'type': 'string', 'description': 'Top entity/module under test (default = first source stem)'},
                'name': {'type': 'string', 'description': 'Basename for the JUnit XML artifact (default "hdltest")'},
            },
            'required': ['module', 'sources'],
        },
    )
    tool_registry.register(
        'hdl_timing_diagram',
        'Turn a signal description into a WaveDrom timing-diagram SVG: pass a '
        'WaveJSON object or text ({"signal": [{"name": "clk", "wave": "p..."}, '
        '{"name": "req", "wave": "01."}]}). Renders via the bundled '
        'wavedrom-cli to <name>.timing.svg in the workspace and always '
        'returns the https://svg.wavedrom.com URL form for zero-install '
        'markdown embedding — protocol/handshake diagrams in chat answers.',
        _hdlTimingDiagram,
        {
            'type': 'object',
            'properties': {
                'wavejson': {
                    'anyOf': [{'type': 'object'}, {'type': 'string'}],
                    'description': 'WaveDrom WaveJSON (object or JSON text) with a "signal" array',
                },
                'name': {'type': 'string', 'description': 'Basename for the .timing.svg artifact (default "timing")'},
            },
            'required': ['wavejson'],
        },
    )
    tool_registry.register(
        'fpga_compile',
        'Compile HDL through the full Quartus flow (quartus_sh --flow '
        'compile: analysis&synthesis → fitter → assembler → timing) and '
        'parse the reports: errors/warnings with file:line, logic '
        'elements/registers/pins vs. device capacity, fmax from the .sta '
        'report, and the .sof artifact copied into the workspace. device '
        'defaults to the Cyclone IV E EP4CE6E22C6; pins maps signal names '
        'to package pins ({"A": "PIN_23", ...}) — the Pin Planner step. '
        'Install guidance when Quartus is absent (circuit_env reports '
        'availability). fpga_program (JTAG download) is a separate, '
        'confirm-gated step.',
        _fpgaCompile,
        {
            'type': 'object',
            'properties': {
                'source': {'type': 'string', 'description': 'Inline VHDL/Verilog text or a workspace file path'},
                'name': {'type': 'string', 'description': 'Project/artifact basename (default "fpga")'},
                'device': {
                    'type': 'string',
                    'description': 'Intel part number (default EP4CE6E22C6 — Cyclone IV E)',
                },
                'top': {'type': 'string', 'description': 'Top-level entity name (default = detected from source)'},
                'pins': {
                    'type': 'object',
                    'description': 'Signal → package pin map, e.g. {"A": "PIN_23", "Y": "PIN_99"}',
                },
            },
            'required': ['source'],
        },
    )
    tool_registry.register(
        'kicad_checks',
        'ERC/DRC correctness gates on real KiCad designs: sch (.kicad_sch) '
        'runs kicad-cli sch erc, pcb (.kicad_pcb) runs pcb drc --format '
        'json --exit-code-violations. Pass either or both. Violations come '
        'back parsed (severity/type/description) with a machine-readable '
        'passed flag per input — agent-verifiable instead of eyeballing. '
        'Install guidance when kicad-cli is absent.',
        _kicadChecks,
        {
            'type': 'object',
            'properties': {
                'sch': {'type': 'string', 'description': 'Workspace .kicad_sch path (schematic ERC)'},
                'pcb': {'type': 'string', 'description': 'Workspace .kicad_pcb path (board DRC)'},
            },
        },
    )
    tool_registry.register(
        'kicad_render',
        'Real-board visuals from a .kicad_pcb via kicad-cli: format=png '
        'runs headless `pcb render`, format=glb runs `pcb export glb` '
        '(interactive 3D model). The artifact lands in the workspace as '
        '<name>.png/.glb and appears in the right-drawer Circuit panel — '
        'the real-design replacement for the zero-dependency board '
        'placeholder. Install guidance when kicad-cli is absent.',
        _kicadRender,
        {
            'type': 'object',
            'properties': {
                'pcb': {'type': 'string', 'description': 'Workspace .kicad_pcb path'},
                'format': {'type': 'string', 'enum': ['png', 'glb'], 'description': 'png = headless 3D render; glb = interactive 3D model'},
                'name': {'type': 'string', 'description': 'Basename for the artifact (default "board")'},
            },
            'required': ['pcb'],
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
        'Search-and-integrate a part or board: datasheet facts, ready-to-paste SPICE model cards for '
        'classics (1N4148/1N4007/2N2222/2N3904...), board specs for Arduino/ESP/Raspberry Pi, and web '
        'datasheet links. Use BEFORE designing with an unfamiliar part so netlists use real parameters.',
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
    tool_registry.register(
        'circuit_env',
        'Environment doctor for the circuit workbench: reports which EDA '
        'engines are installed with versions — ngspice (plus XSPICE '
        'digital-code-model health and batch/server invocation mode), '
        'ghdl, iverilog, verilator, quartus_sh, kicad-cli, arduino-cli, '
        'avr-gcc, node, lcapy — plus a missing/ready summary with install '
        'hints. Read-only; call it before reaching for an engine beyond '
        'plain SPICE.',
        _env,
        {'type': 'object', 'properties': {}},
    )
