"""Circuit workbench — netlist CRUD, ngspice simulation, 3D board render.

Design notes (grounded in how the open-source EDA tools actually work):

* **ngspice** is the same SPICE-3f5-derived engine Kicad's simulator and
  Proteus-class tools use under the hood: it solves nodal equations for
  DC operating points and integrates device models over time for
  transient runs. ``simulate_circuit`` writes a netlist to a temp dir
  and drives the ``ngspice -b`` batch binary, then parses the printed
  measures from stdout — the same artifacts a bench run produces
  (operating point, node voltages, currents), so numbers behave like
  real measurements.
* **3D view**: KiCad exports STEP/glTF via its 3D viewer; we take a
  lighter path — matplotlib's mplot3d renders an interactive-style PNG
  board with component bodies placed on a substrate grid. Good enough
  for "what does this assembly look like", zero native deps.

All file operations are workspace-bound like the rest of the harness.
Circuit tools are only advertised/allowed while the session's circuit
workbench is active (``session.metadata['circuitMode']``) — see
``set_circuit_mode`` / ``is_circuit_mode``, wired to the /circuit command.
"""

from __future__ import annotations

import asyncio
import colorsys
import json
import logging
import math
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.services.sandbox.paths import bind_path

logger = logging.getLogger(__name__)


# ── Circuit-mode gate ─────────────────────────────────────────────────────

def set_circuit_mode(session: object, on: bool) -> None:
    meta = getattr(session, 'metadata', None)
    if not isinstance(meta, dict):
        return
    if on:
        meta['circuitMode'] = True
    else:
        meta.pop('circuitMode', None)


def is_circuit_mode(session: object) -> bool:
    meta = getattr(session, 'metadata', None)
    return bool(isinstance(meta, dict) and meta.get('circuitMode'))


# Injected into the <session> system block while the workbench is active —
# tells the model the surface exists and how to drive it.
CIRCUIT_HINT = (
    'ACTIVE — circuit tools are available: circuit_create_netlist / '
    'circuit_read_netlist / circuit_update_netlist / circuit_delete_netlist '
    '/ circuit_list_netlists (SPICE deck CRUD in the workspace), '
    'circuit_simulate (ngspice batch run of inline text or a deck path; '
    '.op/.dc/.tran/.ac; returns parsed measures plus lint warnings, the '
    'convergence options used, and SOA over-stress warnings), '
    'circuit_test (run a deck once and grade assertions over its '
    'measures — {measure, expect, tolerance} or {measure, min, max} — '
    'returning a machine-readable passed/failed verdict; use it to '
    'self-verify a design before calling it done), '
    'circuit_inject_fault (given deck text + ref + fault open|short|drift '
    'with percent, returns the faulted variant deck for troubleshooting '
    'drills — simulate the result and diff measures against the healthy '
    'deck), '
    'circuit_export_vcd (run a .tran deck with XSPICE digital nodes and '
    'persist a .vcd logic-analyzer file in the workspace — pass the event '
    'node names as signals or omit it to export every event node; returns '
    'vcdFile + duration/valueChanges summary), '
    'circuit_symbolic (lcapy symbolic analysis of a linear deck: H(s) + '
    'LaTeX, poles/zeros, exact V(t) step response — explain the circuit '
    'and cross-check simulated numbers; dc/pulse/sin sources are treated '
    'as steps of the same amplitude), '
    'circuit_search_component (part facts + datasheet links), '
    'circuit_render_3d (KiCad-style board PNG shown in the right Circuit '
    'panel), circuit_list_boards (Arduino/ESP/Raspberry Pi spec sheets), '
    'circuit_integrate_component (search a part/board → datasheet facts + '
    'ready-to-paste SPICE model cards — call it BEFORE designing with an '
    'unfamiliar part; when circuit_env reports xspice=true it also '
    'supplies paste-ready XSPICE subcircuit cards for 74xx logic — '
    '7400/02/04/08/32 gates, 7474/7476 flip-flops, 74161 counter, 74595 '
    'shift register — plus an NE555 macro; family letters are accepted: '
    '74hc00 finds 7400). SPICE units are strict: M = milli, Meg = mega '
    '(1M ohm is a milliohm!), node 0 is ground. KiCad infix values '
    '(4k7, 1R2, R47, 2M2) are accepted and normalized — infix M means '
    'mega there, m means milli. For .tran/.ac decks add '
    '.measure statements (or .control meas blocks) — those numbers come '
    'back parsed as measures; .op also returns every node voltage '
    'v(node)/source current i(vsrc). To see waveforms, pass '
    "circuit_simulate a traces list (e.g. ['v(out)', 'i(r1)', "
    "'vdb(out)']) on .tran/.ac/.dc runs — it returns downsampled "
    'x/y traces plus a tracesFile you can hand straight to render_chart '
    '(kind=line) to plot real oscilloscope/Bode data. To sweep a part '
    'value (e.g. "find where the cutoff hits 1 kHz"), pass '
    'circuit_simulate sweep={param, from, to, steps} and reference the '
    'value in the netlist as {param}; per-step measures come back as '
    'sweepResults=[{paramValue, measures}]. Fix every lint warning and '
    'check soaWarnings before calling a design bench-ready. When a design '
    'uses a dev board, respect its logic level (ESP/Pi = 3.3V, UNO = 5V) '
    'and flag level-shifting needs in your answer. circuit_annotate runs '
    'the .op and draws the schematic SVG with nodes voltage-colored '
    '(blue→red) and branch currents annotated — the at-a-glance bias '
    'picture for explaining a design. firmware_compile builds MCU '
    'firmware (Arduino sketch or C) to a HEX artifact for emulated '
    'execution — pass board=uno/nano/mega and the sketch text; '
    'firmware_run emulates that HEX (avr8js) for bounded milliseconds '
    'and returns serial output, GPIO state, expect/fail assertions, and '
    'the pin-edge timeline that seeds PWL stimulus for ngspice decks. '
    'firmware_stimulus turns that <name>_pins.json timeline into ngspice '
    'PWL source cards (Vp<pin> N<pin> 0 PWL(...)) — optionally injected '
    'into a deck copy as <name>.cir, the firmware→SPICE bridge for '
    'PWM-into-RC-filter runs. hdl_lint is the HDL netlist-lint (ghdl -a '
    'for VHDL, verilator --lint-only for Verilog — file:line diagnostics, '
    'zero-cost after every edit); hdl_simulate runs HDL testbenches '
    '(ghdl --elab-run --wave / iverilog+vvp) and persists the .vcd for '
    'the Circuit panel; vcd_parse reads any VCD — per-signal edge counts, '
    'pulse widths, value-at-time queries, and UART bytes decoded from an '
    'RX line (baud auto-detected) — works on both HDL and SPICE-digital '
    'dumps; hdl_test runs cocotb Python testbenches (uv sync --extra eda) '
    'with a JUnit XML pass/fail verdict; hdl_timing_diagram renders '
    'WaveDrom WaveJSON to a timing-diagram SVG for protocol/handshake '
    'explanations. fpga_compile runs the full Quartus flow on HDL '
    '(analysis → fitter → assembler → timing): pin map via '
    'pins={signal: PIN_xx}, utilization vs. the device (default '
    'EP4CE6E22C6), fmax, and the .sof artifact — reports parsed, never '
    'raw walls. kicad_checks runs ERC/DRC on real KiCad designs '
    '(.kicad_sch/.kicad_pcb — agent-verifiable violation gates) and '
    'kicad_render produces real-board PNG/GLB visuals, replacing the '
    'placeholder path for real designs. '
    'circuit_lint_diagram validates a diagram.json breadboard-wiring '
    'artifact (Wokwi-compatible parts + "part:pin" connections + v/h/* '
    'wire-routing ops) — netlists stay the SPICE source of truth; the '
    'diagram describes breadboard wiring around the MCU and pins the '
    'co-sim mapping. '
    'circuit_env reports '
    'which EDA engines are installed (ngspice + XSPICE health, ghdl, '
    'iverilog, verilator, quartus_sh, kicad-cli, arduino-cli, node) — '
    'call it before reaching for an engine beyond plain SPICE.'
)


# ── Workspace helpers ─────────────────────────────────────────────────────


def _workspace(session: object | None = None) -> str:
    """Session workspace: explicit arg wins, else the ContextVar session."""
    if session is not None:
        ws = str(getattr(session, 'workspacePath', '') or '')
        if ws:
            return ws
    try:
        from app.services.workbench.context import currentSessionId
        from app.services.workbench.sessions import get_workbench_session

        sid = currentSessionId.get()
        if sid and sid != 'default':
            sess = get_workbench_session(sid)
            if sess is not None:
                return str(getattr(sess, 'workspacePath', '') or '')
    except Exception:
        pass
    return ''


def _bind(path: str, workspace: str, for_write: bool):
    bound, err = bind_path(path, workspace, for_write=for_write)
    if err or bound is None:
        raise ValueError(err or f'Invalid path: {path}')
    return bound


_NETLIST_EXT = ('.cir', '.net', '.ckt', '.sp')


def _resolve_ngspice_sync() -> str | None:
    """Locate an ngspice executable (env override, PATH, common install dirs).

    Console builds (``ngspice_con.exe``) are preferred: they are the
    scripting-oriented variant and reliably emit stdout when driven through
    pipes, which the GUI-subsystem ``ngspice.exe`` does not always do.
    """
    env_exe = os.environ.get('AUGUST_NGSPICE_EXE', '').strip()
    if env_exe and os.path.isfile(env_exe):
        return env_exe
    for name in ('ngspice_con', 'ngspice'):
        exe = shutil.which(name)
        if exe:
            return exe
    candidates = [
        r'C:\Program Files\ngspice\bin\ngspice_con.exe',
        r'C:\Program Files\ngspice\bin\ngspice.exe',
        r'C:\ngspice\bin\ngspice_con.exe',
        r'C:\ngspice\bin\ngspice.exe',
        '/usr/bin/ngspice',
        '/usr/local/bin/ngspice',
        '/opt/homebrew/bin/ngspice',
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def resolve_ngspice() -> str | None:
    """Locate ngspice (sync — tests call this directly to skip)."""
    return _resolve_ngspice_sync()


# ── Environment doctor ────────────────────────────────────────────────────

_NGSPICE_INSTALL_HINT = (
    'ngspice is not installed on this machine. Install it from '
    'https://ngspice.sourceforge.io (Windows installer), via the MSYS2 '
    'package mingw-w64-x86_64-ngspice, or through your distro package '
    'manager — the harness uses the same SPICE engine as Kicad/'
    'professional simulators. A non-PATH install can be pointed at with '
    'AUGUST_NGSPICE_EXE. Until then you can still build/edit/draw '
    'circuits with draw_circuit and manage netlists.'
)

# XSPICE probe: a 1-line inverter through the shipped code models. The
# pulse starts at 10n on purpose — an edge at t=0 gets swallowed by the
# digital initial-state resolution and the output looks stuck. The
# dac_bridge converts the digital output node to a 0/1 V analog vector so
# ordinary .meas can see it.
_XSPICE_PROBE_DECK = """* august xspice probe
V1 in 0 PULSE(0 5 10n 1n 1n 50n 100n)
A1 in dout inv
.model inv d_inverter
A2 [dout] [outa] dbridge
.model dbridge dac_bridge
.tran 1n 250n
.control
run
meas tran vmin MIN v(outa)
meas tran vmax MAX v(outa)
.endc
.end
"""

# XSPICE availability as last measured by the env doctor's inverter probe:
# True/False after a circuit_env run, None = not yet measured in this
# process. The 74xx/NE555-macro library is advertised unless the probe
# said False (unknown state attaches a "run circuit_env" note instead of
# hiding parts that probably exist).
_XSPICE_STATE: bool | None = None


def xspice_available() -> bool | None:
    """Last known XSPICE code-model health (None = circuit_env not run)."""
    return _XSPICE_STATE


async def _probe_binary(
    names: tuple[str, ...],
    version_args: tuple[str, ...],
    version_re: str,
    extra_dirs: tuple[str, ...] = (),
    timeout: float = 10.0,
) -> dict[str, object]:
    """Locate a binary (PATH first, then common install dirs) and capture
    one version line from it. Never raises — absence is data, not error."""
    path = None
    for n in names:
        path = shutil.which(n)
        if path:
            break
    if not path:
        exts = ('.exe', '') if os.name == 'nt' else ('',)
        for d in extra_dirs:
            for n in names:
                for ext in exts:
                    c = os.path.join(d, n + ext)
                    if os.path.isfile(c):
                        path = c
                        break
                if path:
                    break
            if path:
                break
    if not path:
        return {'installed': False}
    try:
        proc = await asyncio.create_subprocess_exec(
            path, *version_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out_b, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        out = out_b.decode('utf-8', errors='replace')
    except Exception:
        return {'installed': True, 'path': path, 'version': None}
    m = re.search(version_re, out)
    return {'installed': True, 'path': path, 'version': m.group(1) if m else None}


def _versioned_dirs(roots: tuple[str, ...], sub: str) -> tuple[str, ...]:
    """Expand ``<root>/<version>/<sub>`` for versioned install trees
    (intelFPGA, KiCad), newest version first."""
    out: list[str] = []
    for root in roots:
        try:
            versions = sorted(os.listdir(root), reverse=True)
        except OSError:
            continue
        for v in versions:
            d = os.path.join(root, v, sub)
            if os.path.isdir(d):
                out.append(d)
    return tuple(out)


async def _probe_ngspice() -> dict[str, object]:
    """ngspice availability, version, invocation mode, and XSPICE health."""
    exe = resolve_ngspice()
    if exe is None:
        return {'installed': False, 'hint': _NGSPICE_INSTALL_HINT}
    info: dict[str, object] = {'installed': True, 'path': exe}

    async def _feed(args: list[str], deck: str, timeout: float = 20.0) -> tuple[int | None, str]:
        proc = await asyncio.create_subprocess_exec(
            exe, *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out_b, _ = await asyncio.wait_for(
                proc.communicate(input=deck.encode('utf-8')), timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            return None, '(timeout)'
        return proc.returncode, out_b.decode('utf-8', errors='replace')

    # Version: server mode + -v prints the banner ("** ngspice-45.2 : ...").
    _, banner = await _feed(['-s', '-v'], '* august env probe\n.end\n')
    m = re.search(r'ngspice-(\d+(?:\.\d+)*)', banner)
    if m:
        info['version'] = m.group(1)

    # Invocation mode: batch is canonical, but builds whose batch
    # scratch-file creation is broken outside their native runtime fall
    # back to server mode. Pre-warm the shared cache so the first real
    # simulation doesn't pay for a doomed batch attempt.
    if exe not in _NGSPICE_MODE_CACHE:
        _, bout = await _feed(['-b'], '* august env probe\n.end\n')
        _NGSPICE_MODE_CACHE[exe] = 'server' if _TMPFILE_FAIL_RE.search(bout) else 'batch'
    info['invocation'] = _NGSPICE_MODE_CACHE[exe]

    # XSPICE code models: run the inverter probe; a healthy build swings
    # the bridged output 0 → 1 V.
    _, xout = await _feed(['-s'], _XSPICE_PROBE_DECK)
    if re.search(r'error opening code model', xout, re.I):
        info['xspice'] = False
        info['xspiceNote'] = (
            'Code model libraries (.cm) failed to load — XSPICE digital '
            'parts (74xx, flip-flops) are unavailable in this build.'
        )
    else:
        vmin = vmax = None
        for line in xout.splitlines():
            mm = _MEASURE_RE.match(line)
            if mm and mm.group(1).lower() == 'vmin':
                try:
                    vmin = float(mm.group(2))
                except ValueError:
                    pass
            elif mm and mm.group(1).lower() == 'vmax':
                try:
                    vmax = float(mm.group(2))
                except ValueError:
                    pass
        ok = vmin is not None and vmax is not None and vmin < 0.2 and vmax > 0.8
        info['xspice'] = ok
        if not ok:
            info['xspiceNote'] = (
                'XSPICE probe did not toggle — digital primitives may be '
                'missing from this ngspice build.'
            )
    global _XSPICE_STATE
    _XSPICE_STATE = bool(info.get('xspice'))
    return info


async def circuit_env() -> dict[str, object]:
    """Environment doctor: availability + version of every external engine
    the circuit workbench can drive. Read-only — safe in plan mode.

    Call this before reaching for an engine beyond ngspice (HDL, FPGA,
    firmware, KiCad): its output is what the graceful-degradation messages
    everywhere else are built from.
    """
    import importlib.util

    ngspice = await _probe_ngspice()
    (ghdl, iverilog, verilator, quartus, kicad,
     arduino_cli, avr_gcc, node) = await asyncio.gather(
        _probe_binary(('ghdl',), ('--version',), r'GHDL\s+([0-9][^\s(]*)'),
        _probe_binary(('iverilog',), ('-V',), r'Icarus Verilog version (\S+)'),
        _probe_binary(('verilator',), ('--version',), r'Verilator (\S+)'),
        _probe_binary(
            ('quartus_sh',), ('--version',), r'Version (\d+\.\d+)'),
        _probe_binary(
            ('kicad-cli',), ('version',), r'(\d+\.\d+\.\d+)'),
        _probe_binary(
            ('arduino-cli',), ('version',), r'(\d+\.\d+\.\d+)'),
        _probe_binary(('avr-gcc',), ('--version',), r'(\d+\.\d+\.\d+)'),
        _probe_binary(('node',), ('--version',), r'v?(\d+\.\d+\.\d+)'),
    )
    # Quartus/KiCad live in versioned install trees that are rarely on PATH.
    if not quartus.get('installed'):
        quartus = await _probe_binary(
            ('quartus_sh',), ('--version',), r'Version (\d+\.\d+)',
            extra_dirs=(
                *_versioned_dirs((r'C:\intelFPGA', r'C:\intelFPGA_lite'),
                                 os.path.join('quartus', 'bin64')),
                *_versioned_dirs((r'C:\intelFPGA', r'C:\intelFPGA_lite'),
                                 os.path.join('quartus', 'bin')),
            ))
    if not kicad.get('installed'):
        kicad = await _probe_binary(
            ('kicad-cli',), ('version',), r'(\d+\.\d+\.\d+)',
            extra_dirs=_versioned_dirs((r'C:\Program Files\KiCad',), 'bin'))
    lcapy_installed = importlib.util.find_spec('lcapy') is not None

    tools: dict[str, object] = {
        'ngspice': ngspice,
        'ghdl': ghdl,
        'iverilog': iverilog,
        'verilator': verilator,
        'quartus_sh': quartus,
        'kicad_cli': kicad,
        'arduino_cli': arduino_cli,
        'avr_gcc': avr_gcc,
        'node': node,
        'lcapy': {'installed': lcapy_installed},
    }
    missing = sorted(
        k for k, v in tools.items()
        if not isinstance(v, dict) or not v.get('installed')
    )
    return {
        'tools': tools,
        'missing': missing,
        'ready': sorted(set(tools) - set(missing)),
    }


# ── Netlist CRUD ──────────────────────────────────────────────────────────


def create_netlist(path: str, content: str, workspace: str = '') -> dict[str, object]:
    out = _bind(path, workspace, for_write=True)
    if out.suffix.lower() not in _NETLIST_EXT:
        raise ValueError(f'{path} must end with one of {" / ".join(_NETLIST_EXT)}')
    text = (content or '').strip()
    if not text.lower().startswith('*'):
        # ngspice treats a leading * line as the title/comment line; enforce
        # a well-formed header instead of letting the first component line
        # be swallowed as the title.
        text = f'* netlist\n{text}'
    if not re.search(r'^\.end\s*$', text, re.M | re.I):
        text += '\n.end'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text + '\n', encoding='utf-8')
    return {'path': str(out), 'lines': len(text.splitlines())}


def read_netlist(path: str, workspace: str = '') -> dict[str, object]:
    src = _bind(path, workspace, for_write=False)
    if not src.exists():
        raise ValueError(f'File not found: {path}')
    content = src.read_text(encoding='utf-8', errors='replace')
    components = []
    # Minimum node count per device-class letter (same table lint uses);
    # nodes are the tokens after the refdes up to that count, anything
    # beyond is the value field.
    min_nodes = {'R': 2, 'C': 2, 'L': 2, 'D': 2, 'V': 2, 'I': 2,
                 'Q': 3, 'J': 3, 'M': 3, 'B': 4}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith('*') or line.startswith('.'):
            continue
        parts = line.split()
        if len(parts) >= 2:
            need = min_nodes.get(parts[0][0].upper(), 2)
            nodes = parts[1:1 + need]
            value = parts[1 + need] if len(parts) > 1 + need else ''
            components.append(
                {
                    'name': parts[0],
                    'type': parts[0][0].upper(),
                    'nodes': nodes,
                    'value': value,
                }
            )
    return {'path': str(src), 'components': components, 'content': content}


def update_netlist(path: str, find: str, replace: str, workspace: str = '') -> dict[str, object]:
    src = _bind(path, workspace, for_write=True)
    if not src.exists():
        raise ValueError(f'File not found: {path}')
    content = src.read_text(encoding='utf-8', errors='replace')
    if find not in content:
        raise ValueError(f'Text not found in {path}: {find!r}')
    updated = content.replace(find, replace, 1)
    src.write_text(updated, encoding='utf-8')
    return {'path': str(src), 'replaced': True}


def delete_netlist(path: str, workspace: str = '') -> dict[str, object]:
    target = _bind(path, workspace, for_write=True)
    if target.suffix.lower() not in _NETLIST_EXT:
        raise ValueError(f'Refusing to delete non-netlist file: {path}')
    if not target.exists():
        raise ValueError(f'File not found: {path}')
    target.unlink()
    return {'deleted': str(target)}


def list_netlists(workspace: str = '') -> dict[str, object]:
    if not workspace:
        # No workspace bound: scanning the shared temp dir is slow and
        # surfaces other processes' decks — report empty instead.
        return {'netlists': [], 'count': 0}
    ws = _bind('.', workspace, for_write=False)
    root = ws if ws.is_dir() else ws.parent
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ('.git', 'node_modules', '__pycache__', '.venv')]
        for f in filenames:
            if Path(f).suffix.lower() in _NETLIST_EXT:
                p = Path(dirpath) / f
                found.append(str(p))
        if len(found) >= 200:
            break
    return {'netlists': sorted(found)[:200], 'count': len(found)}


# ── Simulation ────────────────────────────────────────────────────────────

# ngspice prints measures as ``name = value`` and operating-point results
# as ``v(node) = value`` / ``i(vsrc) = value`` — the capture must allow
# parentheses, dots and # (e.g. ``v(1)``, ``i(v1)#branch``).
# Measures carry location suffixes depending on flavor: MIN/MAX append
# "at= <where>", TRIG/TARG append "targ= <t> trig= <t>". Tolerate (and
# ignore) any such key=value tail so every flavor still parses.
_MEASURE_RE = re.compile(
    r'^\s*([\w][\w().#\-]*)\s*=\s*([-+0-9.eE]+)'
    r'(?:\s+[a-zA-Z_]+=\s*[-+0-9.eE]+)*\s*$'
)

# SPICE scale factors (ngspice manual Table 2.1): M = MILLI, Meg = MEGA.
# This asymmetry is the single most common "worked in sim, fried on the
# bench" bug — 1M ohm parses as 1 milliohm.
_SPICE_SCALE: dict[str, float] = {
    'T': 1e12, 'G': 1e9, 'MEG': 1e6, 'K': 1e3, 'MIL': 25.4e-6,
    'M': 1e-3, 'U': 1e-6, 'N': 1e-9, 'P': 1e-12, 'F': 1e-15,
}


# KiCad infix values: the scale letter doubles as the decimal point
# (4k7 = 4.7k, 1R2 = 1.2 Ω, R47 = 0.47 Ω). Students copy these off KiCad
# BOMs; ngspice would silently misread them (1M5 → 1 milli, '5' dropped),
# so they are accepted and normalized. KiCad is case-sensitive for M/m:
# infix M = MEGA, m = milli — the one place M does not mean milli.
_KICAD_INFIX_RE = re.compile(r'^([-+]?)([0-9]+)([A-Za-z])([0-9]+)$')
_KICAD_R_PREFIX_RE = re.compile(r'^([-+]?)R([0-9]+)$')
_KICAD_R_SUFFIX_RE = re.compile(r'^([-+]?)([0-9]+)R$')


def _parse_kicad_infix(s: str) -> float | None:
    m = _KICAD_INFIX_RE.match(s)
    if m:
        sign, int_part, letter, frac_part = m.groups()
        scale: float | None
        if letter in ('R', 'r'):
            scale = 1.0
        elif letter == 'M':
            scale = 1e6
        elif letter == 'm':
            scale = 1e-3
        else:
            scale = _SPICE_SCALE.get(letter.upper())
        if scale is None:
            return None
        return float(f'{sign}{int_part}.{frac_part}') * scale
    m = _KICAD_R_PREFIX_RE.match(s)
    if m:
        return float(f'{m.group(1)}0.{m.group(2)}')
    m = _KICAD_R_SUFFIX_RE.match(s)
    if m:
        return float(f'{m.group(1)}{m.group(2)}')
    return None


def is_kicad_infix(raw: str) -> bool:
    """True when a value string uses the KiCad infix convention."""
    return _parse_kicad_infix((raw or '').strip()) is not None


def parse_spice_value(raw: str) -> float | None:
    """Parse a SPICE numeric value with engineering suffixes.

    Trailing letters after a scale factor are ignored (``10k``, ``4.7k``).
    KiCad infix values (``4k7``, ``1R2``, ``R47``, ``2M2``) are accepted
    and normalized — note infix ``M`` means mega, ``m`` milli. Returns
    None when unparseable.
    """
    s = (raw or '').strip()
    infix = _parse_kicad_infix(s)
    if infix is not None:
        return infix
    m = re.match(r'^([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*([A-Za-z]*)', s)
    if not m:
        return None
    try:
        base = float(m.group(1))
    except ValueError:
        return None
    suffix = m.group(2)
    # Longest match first so 'meg' wins over 'm'.
    for length in (3, 2, 1):
        if len(suffix) >= length:
            factor = _SPICE_SCALE.get(suffix[:length].upper())
            if factor is not None:
                return base * factor
    return base


def lint_netlist(text: str) -> list[str]:
    """Pre-flight checks distilled from the reference simulators.

    KiCad documents the traps; we enforce them mechanically:
      * refdes prefixes must match device class (R/C/L/D/Q/U/V/I...) —
        KiCad assigns passive models *implicitly by reference*, so R123
        as a capacitor silently simulates as a resistor [KiCad manual];
      * values must parse with SPICE scale factors and be physically
        sane (> 0 for R/C/L, sources within ±1 kV);
      * every element line has enough nodes for its device class;
      * at least one ground (node 0) and one source exist;
      * suspicious units like ``1M`` (milli!) are flagged explicitly.
    """
    warnings: list[str] = []
    node_counts: dict[str, int] = {}
    min_nodes = {'R': 2, 'C': 2, 'L': 2, 'D': 2, 'V': 2, 'I': 2,
                 'Q': 3, 'J': 3, 'M': 3, 'B': 4, 'X': 0}
    saw_source = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(('*', '.', '+')):
            continue
        # Inline comment strip (SPICE $ terminator).
        line = line.split('$')[0].strip()
        parts = line.split()
        ref = parts[0]
        prefix = ref[0].upper()
        need = min_nodes.get(prefix, 2)
        nodes = parts[1:-1] if len(parts) > need else parts[1:]
        for nd in nodes:
            node_counts[nd] = node_counts.get(nd, 0) + 1
        if prefix in ('V', 'I'):
            saw_source = True
        # Value sanity
        if len(parts) >= 3 and prefix in ('R', 'C', 'L', 'V', 'I'):
            val = parse_spice_value(parts[-1])
            if val is None:
                warnings.append(
                    f'{ref}: value {parts[-1]!r} does not parse as a SPICE '
                    'number (use e.g. 4.7k, 100u, 22n).'
                )
            elif val <= 0 and prefix in ('R', 'C', 'L'):
                warnings.append(f'{ref}: {prefix} value must be positive.')
            elif prefix == 'R' and 0 < val < 1:
                warnings.append(
                    f'{ref}: resistance {parts[-1]} parses to {val} Ω — did '
                    'you mean Meg? In SPICE "M" is milli, "Meg" is mega '
                    '(KiCad manual: Assigning models).'
                )
            elif prefix == 'C' and val >= 1:
                warnings.append(
                    f'{ref}: capacitance {parts[-1]} parses to {val} F — '
                    'likely a missing u/n/p suffix.'
                )
            if val is not None and is_kicad_infix(parts[-1]):
                warnings.append(
                    f'{ref}: value {parts[-1]!r} is KiCad infix — normalized '
                    f'to {val:g}; prefer plain SPICE form (e.g. 4.7k) in '
                    'decks. Note: infix M means mega, m means milli.'
                )
        if need and len(parts) - 2 < need:
            warnings.append(
                f'{ref}: {prefix}-device needs {need} nodes; line has '
                f'{max(0, len(parts) - 2)}.'
            )
    grounded = any(nd == '0' or nd.lower() == 'gnd' for nd in node_counts)
    if not grounded:
        warnings.append(
            'No ground node: SPICE needs node 0 as the reference (add a '
            'ground, or .global 0). Node "gnd" alone does not anchor DC.'
        )
    if not saw_source:
        warnings.append('No voltage/current source found — nothing to simulate.')
    return warnings


# warn=1 rides every rung: ngspice only emits SOA over-stress lines when
# the warn option is on, and a design that converges on the first rung
# still deserves its safe-operating-area scan.
_CONVERGENCE_LADDER: tuple[dict[str, object], ...] = (
    {'warn': '1'},                                   # pass 1: defaults + SOA
    {'warn': '1', 'gmin': '1e-10'},                  # gentler gmin
    {'warn': '1', 'gmin': '1e-9', 'abstol': '1e-9'},     # looser absolute tolerance
    {'warn': '1', 'gmin': '1e-9', 'abstol': '1e-9', 'itl1': '400'},   # more DC iterations
    {'warn': '1', 'gmin': '1e-9', 'abstol': '1e-9', 'itl1': '400',
     'rshunt': '1e9'},                       # last resort: leak to ground
)

# Some builds (notably the MSYS2/MinGW package) cannot create the scratch
# file batch mode wants ("Could not open a temporary file...") when run
# outside their native runtime. Server mode (``ngspice -s``, deck piped on
# stdin) skips that code path entirely and behaves identically otherwise.
# Detection is per-executable and cached so the ladder doesn't pay for a
# doomed batch attempt on every rung.
_NGSPICE_MODE_CACHE: dict[str, str] = {}
_TMPFILE_FAIL_RE = re.compile(r'could not open a temporary file', re.I)


def _apply_options(deck_text: str, opts: dict[str, object]) -> str:
    """Insert/replace an `.options ...` line right before `.end`."""
    if not opts:
        return deck_text
    opt_line = '.options ' + ' '.join(f'{k}={v}' for k, v in opts.items())
    lines = deck_text.rstrip().splitlines()
    out = []
    replaced = False
    for ln in lines:
        low = ln.strip().lower()
        if low.startswith('.options') and not replaced:
            out.append(opt_line)
            replaced = True
        elif not low.startswith('.options'):
            out.append(ln)
    if not replaced and out and out[-1].strip().lower() == '.end':
        out.insert(len(out) - 1, opt_line)
    elif not replaced:
        out.append(opt_line)
    return '\n'.join(out) + '\n'


def _server_print_block(deck_body: str) -> str:
    """Server mode speaks rawfile binary unless a .control block drives it.

    Control-less decks get ``run`` + ``print all`` injected so they emit
    the same text table batch mode prints; decks that already carry a
    .control block are left in charge of their own output.
    """
    if re.search(r'^\s*\.control\b', deck_body, re.M | re.I):
        return deck_body
    lines = deck_body.rstrip().splitlines()
    out: list[str] = []
    inserted = False
    for ln in lines:
        if not inserted and ln.strip().lower() == '.end':
            out.extend(['.control', 'run', 'print all', '.endc'])
            inserted = True
        out.append(ln)
    if not inserted:
        out.extend(['.control', 'run', 'print all', '.endc'])
    return '\n'.join(out) + '\n'


_SOURCE_KEYWORDS = frozenset({
    'dc', 'ac', 'pulse', 'sin', 'sffm', 'exp', 'pwl', 'trnoise', 'trrandom',
    'value', 'table', 'ic',
})


def _deck_node_names(deck_text: str) -> set[str]:
    """Collect plausible node names from the circuit section.

    Used to alias bare operating-point keys (``mid = 5.0``) to the
    v(node)/i(vsrc) form the workbench advertises. Over-collection (a
    model name read as a node) is harmless — this only feeds aliases.
    """
    nodes: set[str] = set()
    in_control = False
    for ln in deck_text.splitlines():
        s = ln.strip()
        low = s.lower()
        if low.startswith('.control'):
            in_control = True
            continue
        if low.startswith('.endc'):
            in_control = False
            continue
        if in_control or not s or s.startswith('*') or s.startswith('.'):
            continue
        toks = s[1:].split() if s.startswith('+') else s.split()[1:]
        for t in toks:
            if t == '0':
                nodes.add('0')
                continue
            if '(' in t or '=' in t or re.match(r'^[+-]?[\d.]', t):
                break  # value / parameter / source-shape territory
            if t.lower() in _SOURCE_KEYWORDS:
                break
            nodes.add(t.strip('[]'))
    return nodes


def _alias_op_measures(measures: dict[str, float], deck_text: str) -> None:
    """Add v(node)/i(vsrc) aliases for bare operating-point keys so the
    measures dict is identical regardless of ngspice invocation mode."""
    if not measures:
        return
    nodes = _deck_node_names(deck_text)
    for key, value in list(measures.items()):
        if key.endswith('#branch'):
            alias = f'i({key[: -len("#branch")]})'
        elif '(' not in key and key in nodes:
            alias = f'v({key})'
        else:
            continue
        measures.setdefault(alias, value)


# ── Waveform traces (oscilloscope data path) ─────────────────────────────
#
# ``wrdata <file> <expr>`` inside a .control block writes ASCII columns:
# real expressions emit (x, y) pairs; complex .ac expressions emit
# (x, re, im) triples (reduced to magnitude here). One file per
# expression keeps the column layout unambiguous.

_TRACE_MAX = 8        # expressions sampled per run
_TRACE_POINTS = 2000  # downsample budget per trace
# Whitelist keeps expressions inside ngspice's vector math — no newlines,
# no control-language escapes, nothing a deck couldn't already say.
_TRACE_EXPR_RE = re.compile(r'[A-Za-z0-9_().,+\-*/@%$ ]+')


def _normalize_trace_exprs(traces: object) -> tuple[list[str], list[str]]:
    """Validate/dedupe/cap trace expressions → (exprs, warnings)."""
    if traces is None:
        return [], []
    if isinstance(traces, str):
        raw = [traces]
    elif isinstance(traces, (list, tuple)):
        raw = [str(t) for t in traces]
    else:
        return [], [
            f'traces must be a string or list of strings, got {type(traces).__name__}'
        ]
    exprs: list[str] = []
    warnings: list[str] = []
    for item in raw:
        e = str(item).strip()
        if not e:
            continue
        if not _TRACE_EXPR_RE.fullmatch(e):
            warnings.append(f'trace expression rejected (unsafe characters): {e!r}')
            continue
        if e not in exprs:
            exprs.append(e)
    if len(exprs) > _TRACE_MAX:
        warnings.append(f'only the first {_TRACE_MAX} trace expressions are sampled')
        exprs = exprs[:_TRACE_MAX]
    return exprs, warnings


def _detect_analysis(deck_text: str) -> str:
    """Dominant analysis card: 'tran' | 'ac' | 'dc' | 'op' | ''."""
    for kind in ('tran', 'ac', 'dc', 'op'):
        if re.search(rf'^\s*\.{kind}\b', deck_text, re.M | re.I):
            return kind
    return ''


_TRACE_XUNITS = {'tran': 's', 'ac': 'Hz'}


def _dc_sweep_unit(deck_text: str) -> str:
    m = re.search(r'^\s*\.dc\s+([A-Za-z]\w*)', deck_text, re.M | re.I)
    if not m:
        return ''
    first = m.group(1).lower()[0]
    return 'V' if first == 'v' else 'A' if first == 'i' else ''


def _trace_y_unit(expr: str, is_magnitude: bool) -> str:
    if is_magnitude:
        return 'mag'
    e = expr.lower().lstrip()
    if e.startswith(('vdb(', 'db(')):
        return 'dB'
    if e.startswith(('vp(', 'ph(', 'phase(', 'cph(')):
        return 'deg'
    if e.startswith('v('):
        return 'V'
    if e.startswith('i('):
        return 'A'
    return ''


def _with_trace_block(deck_body: str, wrdata_lines: list[str]) -> str:
    """Append a .control section holding wrdata commands before ``.end``.

    Inserted after all existing control content so the plot exists (the
    run has executed) by the time wrdata samples it.
    """
    if not wrdata_lines:
        return deck_body
    lines = deck_body.rstrip().splitlines()
    out: list[str] = []
    inserted = False
    for ln in lines:
        if not inserted and ln.strip().lower() == '.end':
            out.append('.control')
            out.extend(wrdata_lines)
            out.append('.endc')
            inserted = True
        out.append(ln)
    if not inserted:
        out.append('.control')
        out.extend(wrdata_lines)
        out.append('.endc')
    return '\n'.join(out) + '\n'


def _parse_wrdata(text: str) -> tuple[list[float], list[float], bool] | None:
    """Parse wrdata ASCII columns → (x, y, was_complex).

    2 columns = (x, y) real pair; 3 columns = (x, re, im) complex →
    magnitude. Rows with other shapes are skipped.
    """
    xs: list[float] = []
    ys: list[float] = []
    complex_ = False
    for ln in text.splitlines():
        toks = ln.split()
        try:
            if len(toks) == 2:
                xs.append(float(toks[0]))
                ys.append(float(toks[1]))
            elif len(toks) == 3:
                xs.append(float(toks[0]))
                ys.append(math.hypot(float(toks[1]), float(toks[2])))
                complex_ = True
        except ValueError:
            continue
    if not xs:
        return None
    return xs, ys, complex_


def _downsample(
    xs: list[float], ys: list[float], budget: int = _TRACE_POINTS
) -> tuple[list[float], list[float]]:
    """Stride-thin to ≤ budget points, always keeping the endpoints."""
    n = len(xs)
    if n <= budget:
        return xs, ys
    step = (n - 1) / (budget - 1)
    idxs = sorted({min(n - 1, round(i * step)) for i in range(budget)} | {0, n - 1})
    return [xs[i] for i in idxs], [ys[i] for i in idxs]


# ── Parametric sweeps (LTspice-.step semantics, ngspice mechanics) ───────
#
# ngspice has no `.step` card — the native mechanism is a .control loop:
# foreach value / alterparam / reset / run. Circuit-section .measure
# cards re-evaluate on every iteration, so per-step numbers come back as
# one `name = value` line per step, in sweep order.

_SWEEP_MAX_STEPS = 50
_SWEEP_PARAM_RE = re.compile(r'[A-Za-z_]\w*')


def _spice_num(v: float) -> str:
    """Format a number ngspice's parser always accepts (no e-notation)."""
    if v == int(v) and abs(v) < 1e15:
        return str(int(v))
    return format(v, '.12f').rstrip('0').rstrip('.')


def _normalize_sweep(sweep: object) -> tuple[dict[str, Any] | None, list[str]]:
    """Validate sweep spec {param, from, to, steps} → (spec, warnings)."""
    if sweep is None:
        return None, []
    if not isinstance(sweep, dict):
        return None, ['sweep must be an object {param, from, to, steps}']
    warns: list[str] = []
    param = str(sweep.get('param') or '').strip()
    if not _SWEEP_PARAM_RE.fullmatch(param):
        return None, [f'sweep.param must be a SPICE parameter name, got {param!r}']
    try:
        lo = float(sweep.get('from'))  # type: ignore[arg-type]
        hi = float(sweep.get('to'))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None, ['sweep.from / sweep.to must be numbers (raw SI values)']
    if lo == hi:
        return None, ['sweep.from and sweep.to must differ']
    try:
        steps = int(sweep.get('steps') or 2)
    except (TypeError, ValueError):
        return None, ['sweep.steps must be an integer ≥ 2']
    if steps < 2:
        return None, ['sweep.steps must be ≥ 2']
    if steps > _SWEEP_MAX_STEPS:
        warns.append(f'sweep.steps capped at {_SWEEP_MAX_STEPS}')
        steps = _SWEEP_MAX_STEPS
    values = [lo + (hi - lo) * i / (steps - 1) for i in range(steps)]
    return {'param': param, 'from': lo, 'to': hi, 'steps': steps, 'values': values}, warns


def _with_sweep_loop(
    deck_text: str, param: str, values: list[float], analysis: str
) -> tuple[str, bool]:
    """Rewrite the deck so each parameter value gets its own run.

    Any existing .control block(s) are drained of their ``run`` lines and
    their remaining commands (meas statements etc.) are replayed inside
    the loop, once per step. Control-less decks get ``print all`` per
    step on .op runs so node voltages still come back.
    """
    lines = deck_text.rstrip().splitlines()
    body: list[str] = []
    kept_cmds: list[str] = []
    in_control = False
    has_measure = False
    for ln in lines:
        low = ln.strip().lower()
        if low.startswith('.control'):
            in_control = True
            continue
        if low.startswith('.endc'):
            in_control = False
            continue
        if in_control:
            cmd = ln.strip()
            if cmd and cmd.lower() != 'run':
                kept_cmds.append(cmd)
                if cmd.lower().startswith('meas'):
                    has_measure = True
            continue
        if low.startswith('.measure'):
            has_measure = True
        body.append(ln)

    # The parameter must exist for alterparam — add a .param default if
    # the deck never declared it (before .end, or ngspice ignores it).
    if not re.search(
        rf'^\s*\.param\b[^\n]*\b{re.escape(param)}\s*=', '\n'.join(body),
        re.M | re.I,
    ):
        end_idx = next(
            (i for i, ln in enumerate(body) if ln.strip().lower() == '.end'),
            len(body),
        )
        body.insert(end_idx, f'.param {param}={_spice_num(values[0])}')

    per_step = list(kept_cmds)
    if not per_step and analysis == 'op':
        per_step.append('print all')

    loop = ['.control', f'foreach swv {" ".join(_spice_num(v) for v in values)}']
    loop.append(f'alterparam {param} = $swv')
    loop.extend(['reset', 'run'])
    loop.extend(per_step)
    loop.extend(['end', '.endc'])

    out: list[str] = []
    inserted = False
    for ln in body:
        if not inserted and ln.strip().lower() == '.end':
            out.extend(loop)
            inserted = True
        out.append(ln)
    if not inserted:
        out.extend(loop)
    return '\n'.join(out) + '\n', has_measure


def _collect_sweep_results(
    log: str, values: list[float], deck_text: str = ''
) -> list[dict[str, object]]:
    """Group repeated measure lines into per-step dicts (sweep order).

    With ``deck_text`` the bare op-point keys each step prints get the
    same v(node)/i(vsrc) aliases a plain .op run provides.
    """
    per_name: dict[str, list[float]] = {}
    for line in log.splitlines():
        m = _MEASURE_RE.match(line)
        if not m:
            continue
        try:
            per_name.setdefault(m.group(1), []).append(float(m.group(2)))
        except ValueError:
            continue
    results: list[dict[str, object]] = []
    for i, pv in enumerate(values):
        ms = {name: vals[i] for name, vals in per_name.items() if i < len(vals)}
        if deck_text:
            _alias_op_measures(ms, deck_text)
        results.append({'paramValue': pv, 'measures': ms})
    return results


async def simulate_circuit(
    netlist: str,
    name: str = 'sim',
    workspace: str = '',
    session: object | None = None,
    traces: object | None = None,
    sweep: object | None = None,
) -> dict[str, object]:
    """Run an ngspice batch simulation and parse the printed measures.

    ``netlist`` may be inline SPICE text OR a path to a .cir/.net/.ckt
    file in the workspace (auto-detected). Analysis cards mirror physical
    benches: ``.op`` (operating point = what a multimeter reads at rest),
    ``.dc`` sweeps, ``.tran`` (oscilloscope-style time domain), ``.ac``
    (frequency response).

    ``traces`` (optional) lists waveform expressions to sample on
    ``.tran/.ac/.dc`` runs — e.g. ``['v(out)', 'i(r1)', 'vdb(out)']``.
    They come back as ``traces: {expr: {x, y, xunit, unit, points}}``
    downsampled to a rendering budget, plus a ``tracesFile`` JSON in the
    workspace that ``render_chart`` accepts directly.

    ``sweep`` (optional) is ``{param, from, to, steps}`` — the deck is
    re-run once per parameter value (LTspice-.step semantics via an
    alterparam loop) and per-step measures come back as
    ``sweepResults: [{paramValue, measures}]``.

    Fidelity pipeline (distilled from KiCad/ngspice/Proteus practice):
      1. ``lint_netlist`` pre-flight — the unit/refdes traps that make a
         deck "pass" while meaning something else;
      2. convergence ladder — on failure, retry with progressively
         relaxed `.options` (gmin → abstol → itl1 → rshunt) exactly the
         way ngspice itself escapes non-converging operating points;
      3. SOA stress scan — with ``warn`` enabled, over-limit device
         voltages/currents/power are surfaced so a design that simulates
         but would burn on the bench gets flagged BEFORE prototyping.
    """
    ws = workspace or _workspace(session)
    exe = resolve_ngspice()
    if exe is None:
        return {
            'installed': False,
            'error': _NGSPICE_INSTALL_HINT,
        }

    tmpdir = tempfile.mkdtemp(prefix='aug_circuit_')
    try:
        source_is_file = False
        stripped = (netlist or '').strip()
        if stripped and not any(ch in stripped for ch in ('\n',)) and len(stripped) < 260:
            candidate = _bind(stripped, ws, for_write=False)
            if candidate.exists():
                source_is_file = True
                deck_text = candidate.read_text(encoding='utf-8', errors='replace')
            else:
                deck_text = stripped
        else:
            deck_text = stripped
        if not deck_text:
            raise ValueError('netlist is empty.')
        if not deck_text.lstrip().lower().startswith('*'):
            deck_text = f'* simulation deck\n{deck_text}'
        if not re.search(r'^\.end\s*$', deck_text, re.M | re.I):
            deck_text += '\n.end'

        # 1) Pre-flight lint — report immediately; these are correctness
        # issues no amount of convergence coaxing can fix.
        lint = lint_netlist(deck_text)

        # Waveform trace setup: one wrdata file per expression, appended as
        # a trailing .control block so it samples after the run.
        trace_exprs, trace_warnings = _normalize_trace_exprs(traces)
        analysis = _detect_analysis(deck_text)
        if trace_exprs and analysis not in ('tran', 'ac', 'dc'):
            trace_warnings.append(
                'traces need a .tran/.ac/.dc sweep — deck has none; skipped'
            )
            trace_exprs = []
        wrdata_lines = [f'wrdata tr{i}.dat {e}' for i, e in enumerate(trace_exprs)]

        # Parametric sweep setup: rewrite the deck into an alterparam loop.
        # The user's deck stays pristine for lint/savedTo; the loop variant
        # is only what ngspice executes.
        sweep_spec, sweep_warnings = _normalize_sweep(sweep)
        run_deck_text = deck_text
        if sweep_spec is not None:
            if trace_exprs:
                sweep_warnings.append(
                    'sweep active — traces skipped; plot the curve family '
                    'from sweepResults instead'
                )
                trace_exprs, wrdata_lines = [], []
            run_deck_text, has_measure = _with_sweep_loop(
                deck_text,
                str(sweep_spec['param']),
                list(sweep_spec['values']),
                analysis,
            )
            if not has_measure and analysis != 'op':
                sweep_warnings.append(
                    'deck has no .measure statements — sweepResults will be '
                    'empty; add .measure cards to collect per-step numbers'
                )

        import asyncio

        out_txt = Path(tmpdir) / 'out.txt'
        log_txt = Path(tmpdir) / 'log.txt'

        async def _run_once(options: dict[str, object]) -> tuple[int | None, str]:
            """Run the deck with the given .options.

            Batch mode (``-b``) is the canonical path; builds whose batch
            scratch-file creation is broken fall back to server mode
            (``-s``, deck on stdin) transparently — see
            ``_NGSPICE_MODE_CACHE``.
            """
            deck_body = _apply_options(run_deck_text, options)

            async def _spawn(args: list[str], stdin_data: bytes | None) -> tuple[int | None, str]:
                proc = await asyncio.create_subprocess_exec(
                    exe,
                    *args,
                    stdin=asyncio.subprocess.PIPE if stdin_data is not None else None,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                    cwd=tmpdir,
                )
                try:
                    stdout_b, _ = await asyncio.wait_for(
                        proc.communicate(input=stdin_data), timeout=60,
                    )
                except asyncio.TimeoutError:
                    proc.kill()
                    return None, '(timeout after 60s)'
                return proc.returncode, stdout_b.decode('utf-8', errors='replace')

            mode = _NGSPICE_MODE_CACHE.get(exe, 'batch')
            if mode == 'batch':
                deck = Path(tmpdir) / 'deck.cir'
                deck.write_text(
                    _with_trace_block(deck_body, wrdata_lines), encoding='utf-8'
                )
                for f in (out_txt, log_txt):
                    if f.exists():
                        f.unlink()
                rc, out = await _spawn(['-b', '-o', str(out_txt), str(deck)], None)
                log = ''
                for f in (out_txt, log_txt):
                    if f.exists():
                        log += f.read_text(encoding='utf-8', errors='replace')
                if not log:
                    log = out
                if _TMPFILE_FAIL_RE.search(log):
                    _NGSPICE_MODE_CACHE[exe] = 'server'
                else:
                    return rc, log
            # Server mode: ngspice reads the deck from stdin and prints
            # everything to stdout (no -o file). The trace block goes in
            # AFTER the (possibly injected) run/print-all control section.
            server_deck = _with_trace_block(
                _server_print_block(deck_body), wrdata_lines
            )
            return await _spawn(['-s'], server_deck.encode('utf-8'))

        # 2) Convergence ladder: default options first, relax stepwise.
        exit_code: int | None = None
        log = ''
        used_options: dict[str, object] = {}
        for attempt, opts in enumerate(_CONVERGENCE_LADDER):
            exit_code, log = await _run_once(opts)
            used_options = opts
            failed = (
                exit_code not in (0, None)
                or re.search(r'no convergence|failed to start|singular matrix|could not', log, re.I)
            )
            if not failed:
                break
            if attempt == len(_CONVERGENCE_LADDER) - 1:
                break  # last rung — report as-is

        measures: dict[str, float] = {}
        sweep_results: list[dict[str, object]] | None = None
        if sweep_spec is not None:
            # Per-step data lives in sweepResults — the scalar measures
            # dict would only hold the last step's numbers, which misleads.
            sweep_results = _collect_sweep_results(
                log, list(sweep_spec['values']), deck_text
            )
        else:
            for line in log.splitlines():
                m = _MEASURE_RE.match(line)
                if m:
                    try:
                        measures[m.group(1)] = float(m.group(2))
                    except ValueError:
                        pass
            # Bare op-point keys (mid = 5.0, v1#branch = ...) get v()/i()
            # aliases so the contract holds in every invocation mode.
            _alias_op_measures(measures, deck_text)
        errors = [
            ln for ln in log.splitlines()
            if re.search(r"\berror\b|\bcouldn't|failed|unknown", ln, re.I)
        ]
        # SOA warnings from ngspice (.options warn=1 rides every ladder
        # rung): these are the "will survive the bench" signals — device
        # voltage / current / power beyond model limits.
        soa = [
            ln.strip() for ln in log.splitlines()
            if re.search(r'soa|safe operating|exceeds|too (high|large)', ln, re.I)
        ]

        result: dict[str, object] = {
            'installed': True,
            'engine': 'ngspice (SPICE-3f5 derived, same core as Kicad)',
            'deck': deck_text,
            'sourceIsFile': source_is_file,
            'exitCode': exit_code,
            'measures': measures,
            'errors': errors[:12],
            'lint': lint,
            'convergedWith': used_options or None,
            'soaWarnings': soa[:12],
            'logTail': '\n'.join(log.splitlines()[-40:]),
        }
        # Waveform traces: read back the wrdata files from the final run.
        if trace_exprs and exit_code in (0, None):
            xunit = _TRACE_XUNITS.get(analysis) or _dc_sweep_unit(deck_text)
            traces_out: dict[str, object] = {}
            for i, expr in enumerate(trace_exprs):
                tf = Path(tmpdir) / f'tr{i}.dat'
                if not tf.exists():
                    trace_warnings.append(
                        f'no wrdata output for {expr} (run produced no plot?)'
                    )
                    continue
                parsed = _parse_wrdata(
                    tf.read_text(encoding='utf-8', errors='replace')
                )
                if parsed is None:
                    trace_warnings.append(f'could not parse wrdata output for {expr}')
                    continue
                xs, ys, is_mag = parsed
                total = len(xs)
                xs, ys = _downsample(xs, ys)
                traces_out[expr] = {
                    'x': xs,
                    'y': ys,
                    'xunit': xunit,
                    'unit': _trace_y_unit(expr, is_mag),
                    'points': total,
                }
            if traces_out:
                result['traces'] = traces_out
                if ws:
                    base = str(name)
                    base = base[: -len('.cir')] if base.endswith('.cir') else base
                    keep_traces = _bind(f'{base}_traces.json', ws, for_write=True)
                    keep_traces.write_text(json.dumps(traces_out), encoding='utf-8')
                    result['tracesFile'] = str(keep_traces)
        if trace_warnings:
            result['traceWarnings'] = trace_warnings
        if sweep_spec is not None and sweep_results is not None:
            result['sweep'] = {
                'param': sweep_spec['param'],
                'from': sweep_spec['from'],
                'to': sweep_spec['to'],
                'steps': sweep_spec['steps'],
            }
            result['sweepResults'] = sweep_results
        if sweep_warnings:
            result['sweepWarnings'] = sweep_warnings
        # Persist the deck into the workspace when the input was inline, so
        # the run has a durable artifact the user can edit/re-run.
        if not source_is_file and ws:
            keep = _bind(f'{name}.cir' if not str(name).endswith('.cir') else str(name), ws, for_write=True)
            keep.write_text(deck_text + '\n', encoding='utf-8')
            result['savedTo'] = str(keep)
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── circuit_test — assertions over measures (design → assert → fix) ──────


def _evaluate_assertions(
    measures: dict[str, float], assertions: object
) -> tuple[list[dict[str, object]], list[str]]:
    """Evaluate assertion specs against parsed measures → (results, errors).

    Each assertion is ``{measure, expect, tolerance}`` (relative tolerance;
    absolute when expect == 0) or ``{measure, min, max}`` (range check —
    either bound optional).
    """
    if not isinstance(assertions, (list, tuple)):
        raise ValueError('assertions must be a list of {measure, expect|min/max} objects')
    results: list[dict[str, object]] = []
    errors: list[str] = []
    for idx, raw in enumerate(assertions):
        if not isinstance(raw, dict):
            errors.append(f'assertion[{idx}] is not an object')
            continue
        mname = str(raw.get('measure') or '').strip()
        if not mname:
            errors.append(f'assertion[{idx}] is missing its measure name')
            continue
        entry: dict[str, object] = {'name': mname, 'value': None, 'ok': False}
        value = measures.get(mname)
        if value is None:
            entry['note'] = f'measure {mname!r} not found in simulation output'
            results.append(entry)
            continue
        entry['value'] = value
        try:
            if raw.get('expect') is not None:
                exp = float(raw['expect'])  # type: ignore[arg-type]
                tol = float(raw.get('tolerance', 0.01))  # type: ignore[arg-type]
                if tol < 0:
                    raise ValueError('tolerance must be ≥ 0')
                entry['expect'] = exp
                entry['tolerance'] = tol
                ok = math.isclose(value, exp, rel_tol=tol, abs_tol=tol if exp == 0 else 0.0)
                entry['ok'] = ok
                pct = f'{tol:.0%}' if tol else 'exactly'
                entry['note'] = (
                    f'{value:.6g} within {pct} of {exp:.6g}'
                    if ok else f'{value:.6g} NOT within {pct} of {exp:.6g}'
                )
            elif raw.get('min') is not None or raw.get('max') is not None:
                lo = None if raw.get('min') is None else float(raw['min'])  # type: ignore[arg-type]
                hi = None if raw.get('max') is None else float(raw['max'])  # type: ignore[arg-type]
                entry['expect'] = f'[{lo if lo is not None else "-inf"}, {hi if hi is not None else "inf"}]'
                ok = (lo is None or value >= lo) and (hi is None or value <= hi)
                entry['ok'] = ok
                entry['note'] = (
                    f'{value:.6g} inside range' if ok else f'{value:.6g} OUTSIDE range'
                )
            else:
                errors.append(
                    f'assertion[{idx}] ({mname}) needs expect+tolerance or min/max'
                )
                entry['note'] = 'malformed assertion'
                results.append(entry)
                continue
        except (TypeError, ValueError) as exc:
            errors.append(f'assertion[{idx}] ({mname}): {exc}')
            entry['note'] = f'malformed assertion: {exc}'
            results.append(entry)
            continue
        results.append(entry)
    return results, errors


async def circuit_test(
    netlist: str,
    assertions: object,
    name: str = 'test',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Run a deck once and grade assertions over its measures.

    The agent's self-verification loop: design → assert → fix, with a
    machine-readable verdict instead of prose. ``assertions`` is a list
    of ``{measure, expect, tolerance}`` (relative; absolute when expect
    is 0) or ``{measure, min, max}`` range checks. Returns
    ``{passed, results: [{name, value, expect, ok, note}]}`` plus the
    underlying measures for fixing failures.
    """
    sim = await simulate_circuit(
        netlist, name=name, workspace=workspace, session=session
    )
    if sim.get('installed') is False:
        return {
            'passed': False,
            'results': [],
            'error': sim.get('error'),
            'hint': sim.get('hint'),
        }
    measures = sim.get('measures')
    measures = measures if isinstance(measures, dict) else {}
    results, errors = _evaluate_assertions(measures, assertions)  # type: ignore[arg-type]
    sim_failed = sim.get('exitCode') not in (0, None)
    passed = bool(results) and not errors and not sim_failed and all(
        r['ok'] for r in results
    )
    out: dict[str, object] = {
        'passed': passed,
        'results': results,
        'measures': measures,
        'exitCode': sim.get('exitCode'),
    }
    if errors:
        out['assertionErrors'] = errors
    if sim_failed or sim.get('errors'):
        raw_errors = sim.get('errors')
        if isinstance(raw_errors, (list, tuple)):
            out['simErrors'] = [str(e) for e in raw_errors][:6]
    if sim.get('soaWarnings'):
        out['soaWarnings'] = sim['soaWarnings']
    return out


# ── Fault injection (troubleshooting drills) ──────────────────────────────

_FAULT_KINDS = ('open', 'short', 'drift')


def _find_element_span(lines: list[str], ref: str) -> tuple[int, int] | None:
    """Line span [start, end) of ref's element line incl. '+' continuations.

    Line 0 is the SPICE title (ngspice never parses it as an element), so
    it is skipped unless it is already a comment/control card.
    """
    start_at = 1 if lines and not lines[0].strip().startswith(('*', '.')) else 0
    for i in range(start_at, len(lines)):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith(('*', '.', '+')):
            continue
        if stripped.split('$')[0].split()[0].lower() != ref.lower():
            continue
        end = i + 1
        while end < len(lines) and lines[end].strip().startswith('+'):
            end += 1
        return i, end
    return None


def _element_refs(deck_text: str) -> list[str]:
    """Element reference designators in a deck (for error messages)."""
    refs: list[str] = []
    for i, raw in enumerate(deck_text.splitlines()):
        stripped = raw.strip()
        if i == 0 and not stripped.startswith(('*', '.')):
            continue  # title line
        if not stripped or stripped.startswith(('*', '.', '+')):
            continue
        refs.append(stripped.split('$')[0].split()[0])
    return refs


def inject_fault(
    netlist: str, ref: str, fault: str, percent: object = None,
) -> dict[str, object]:
    """Fault a SPICE deck and return the variant deck (troubleshooting drills).

    Multisim-Education-style fault simulation: given a healthy deck and a
    part reference, emit the faulted variant so a student (or August) can
    diagnose the symptom by simulation. Faults:

      * ``open``  — part removed entirely (its line is deleted);
      * ``short`` — part replaced by a 1 mΩ resistor across its first two
        nodes (``R<ref>_f n1 n2 1m``);
      * ``drift`` — part value scaled by ``percent`` (e.g. 20 or -30);
        only R/C/L carry a single drift-able value.

    Pure text transform: nothing is written or run — feed the returned
    netlist to ``simulate_circuit``/``circuit_test`` to observe the symptom.
    """
    deck = (netlist or '').strip()
    if not deck:
        return {'error': 'netlist is empty — pass SPICE deck text.'}
    ref = (ref or '').strip()
    if not ref:
        return {'error': 'ref is required (the part name, e.g. R1).'}
    fault_norm = (fault or '').strip().lower()
    if fault_norm not in _FAULT_KINDS:
        return {
            'error': f'fault must be one of {"|".join(_FAULT_KINDS)}, got {fault!r}.',
        }

    lines = deck.splitlines()
    span = _find_element_span(lines, ref)
    if span is None:
        shown = ', '.join(_element_refs(deck)[:20]) or '(none found)'
        return {'error': f'no element named {ref!r} in this deck. Elements: {shown}.'}
    start, end = span
    head = lines[start].split('$')[0].split()
    actual_ref = head[0]
    hint = ('Simulate the faulted deck (simulate_circuit / circuit_test) and '
            'compare its measures with the healthy deck to see the symptom.')

    if fault_norm == 'open':
        out_lines = lines[:start] + lines[end:]
        return {
            'ref': actual_ref, 'fault': 'open',
            'change': f'{actual_ref}: opened — element line removed.',
            'netlist': '\n'.join(out_lines) + '\n', 'hint': hint,
        }

    nodes = head[1:3]
    if fault_norm == 'short':
        if len(nodes) < 2:
            return {
                'error': f'{actual_ref}: need two nodes to short across; '
                         f'line has {len(nodes)}.',
            }
        short_line = f'R{actual_ref}_f {nodes[0]} {nodes[1]} 1m'
        out_lines = lines[:start] + [short_line] + lines[end:]
        return {
            'ref': actual_ref, 'fault': 'short',
            'change': f'{actual_ref}: shorted — 1 mΩ across {nodes[0]}–{nodes[1]}.',
            'netlist': '\n'.join(out_lines) + '\n', 'hint': hint,
        }

    # drift — scale the part's value by a percentage.
    prefix = actual_ref[0].upper()
    if prefix not in ('R', 'C', 'L'):
        return {
            'error': f'{actual_ref}: drift applies to R/C/L values; '
                     f'{prefix}-devices have no single scalable value.',
        }
    if end - start > 1:
        return {
            'error': f'{actual_ref}: element spans continuation lines; '
                     'drift needs a single-line value.',
        }
    try:
        pct = float(percent)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return {'error': 'drift needs a numeric percent (e.g. 20 for +20%, -30 for −30%).'}
    if pct <= -100:
        return {'error': f'percent {pct:g} would drive the value to zero or negative.'}
    if len(head) < 4:
        return {
            'error': f'{actual_ref}: expected "ref n1 n2 value"; line has no value token.',
        }
    old = parse_spice_value(head[-1])
    if old is None:
        return {'error': f'{actual_ref}: value {head[-1]!r} does not parse as a SPICE number.'}
    new = old * (1.0 + pct / 100.0)
    if new <= 0:
        return {'error': f'{actual_ref}: {pct:g}% drift yields {new:g} — not positive.'}
    drifted = ' '.join(head[:-1]) + ' ' + _spice_num(new)
    out_lines = lines[:start] + [drifted] + lines[end:]
    return {
        'ref': actual_ref, 'fault': 'drift',
        'change': f'{actual_ref}: drifted {pct:+g}% — {head[-1]} → {_spice_num(new)}.',
        'netlist': '\n'.join(out_lines) + '\n', 'hint': hint,
    }


# ── Symbolic analysis (lcapy — H(s), poles/zeros, V(t), LaTeX) ───────────

LCAPY_INSTALL_HINT = (
    'lcapy is not installed. Add it with `uv sync --extra eda` (from '
    'backend-py/) or `uv pip install lcapy` — LGPL-2.1, linkable. It '
    'powers symbolic transfer functions, poles/zeros, and exact step '
    'responses for circuit_symbolic.'
)

# lcapy netlist dialect: sources need a symbolic form. DC/PULSE/SIN
# cards are rewritten to `step <v>` so the Laplace machinery has
# something to transform; .tran/.ac/.measure/.control lines are dropped.
_LCAPY_DROP_RE = re.compile(
    r'^\s*\.(tran|ac|dc|measure|meas|control|endc|options|op|end|param|model|include|four|step|plot|probe|save|print)\b.*',
    re.I,
)
_LCAPY_SOURCE_RE = re.compile(
    r'^(?P<ref>V\d+)\s+(?P<n1>\S+)\s+(?P<n2>\S+)\s+(?P<kind>dc|step|ac|pulse|sin|sffm|exp|pwl)\s*(?P<rest>.*)$',
    re.I,
)


def _to_lcapy_netlist(deck_text: str) -> tuple[str, list[str]]:
    """SPICE deck → lcapy netlist + notes about what was adapted.

    Independent sources with a numeric DC/PULSE/SIN/… value become lcapy
    ``step`` sources of that amplitude (a 5 V pulse reads as a 5 V step —
    the transient shape is lost, the operating math is kept). Analysis
    cards, .control blocks, .model/.param decks and title comments are
    dropped: lcapy solves the linear network, not the simulation
    directives.
    """
    notes: list[str] = []
    out: list[str] = []
    in_control = False
    for raw in deck_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        # Whole .control blocks are dropped — the commands inside
        # (run, meas, print…) are simulation directives, not circuit.
        if low == '.control':
            in_control = True
            continue
        if low == '.endc':
            in_control = False
            continue
        if in_control:
            continue
        if line.startswith('*'):
            continue
        if _LCAPY_DROP_RE.match(line):
            continue
        m = _LCAPY_SOURCE_RE.match(line)
        if m and m.group('kind').lower() != 'step':
            kind = m.group('kind').lower()
            amp_m = re.match(r'\S+', m.group('rest').strip())
            amp = amp_m.group(0) if amp_m else '1'
            out.append(f"{m.group('ref')} {m.group('n1')} {m.group('n2')} step {amp}")
            notes.append(
                f"{m.group('ref')}: {kind} source → step {amp} "
                '(transient shape dropped; amplitude kept)'
            )
            continue
        out.append(line)
    return '\n'.join(out), notes


def _lcapy_ok() -> bool:
    import importlib.util

    return importlib.util.find_spec('lcapy') is not None


def circuit_symbolic(
    netlist: str,
    node: str = '',
    ref: str = '',
) -> dict[str, object]:
    """Symbolically analyze a linear circuit with lcapy.

    Returns the transfer function H(s) = V(node)/V(source) (simplified,
    plus LaTeX), its poles and zeros with multiplicities, the exact V(t)
    step response at the queried node, and a LaTeX rendering of each —
    the *explanation* layer that cross-checks ngspice's numbers. The
    source amplitude enters symbolically: drive the netlist with a DC
    source (rewritten to ``step``) or write ``V1 1 0 step 5`` directly.

    ``node`` names the output node (defaults to the highest-numbered
    node in the deck); ``ref`` picks a specific source for H(s) when
    several exist.
    """
    if not _lcapy_ok():
        return {'installed': False, 'error': LCAPY_INSTALL_HINT}
    if not (netlist or '').strip():
        return {'error': 'netlist is required — inline SPICE text or a deck.'}

    from lcapy import Circuit, s, t  # noqa: F401 — s/t imported for callers

    body, notes = _to_lcapy_netlist(netlist)
    try:
        cct = Circuit(body)
    except Exception as exc:
        return {
            'error': f'lcapy could not parse the netlist: {exc}',
            'adaptedNetlist': body or '(empty after adaptation)',
            'notes': notes,
        }

    # Output node: explicit, else the highest-numbered non-ground node,
    # else (named nodes like in/out) the last node the deck mentions.
    if node:
        out_node = node
    else:
        numeric: list[int] = []
        named: list[str] = []
        for n in cct.nodes:
            name = str(n)
            if name in ('0', 'gnd'):
                continue
            if re.fullmatch(r'\d+', name):
                numeric.append(int(name))
            else:
                named.append(name)
        if numeric:
            out_node = str(max(numeric))
        elif named:
            out_node = named[-1]
        else:
            return {'error': 'no non-ground nodes found in the netlist.'}

    try:
        vout = cct[out_node].V(s)
    except Exception as exc:
        return {
            'error': f'node {out_node!r} not found or not solvable: {exc}',
            'adaptedNetlist': body, 'notes': notes,
        }

    # Source pick for H(s): explicit ref, else the first V element.
    src = None
    if ref:
        if ref not in cct.elements:
            return {
                'error': f'source {ref!r} not found in the netlist.',
                'adaptedNetlist': body, 'notes': notes,
            }
        src = ref
    else:
        for name in cct.elements:
            if name.upper().startswith('V'):
                src = name
                break
    if src is None:
        return {
            'error': 'no independent voltage source found for H(s).',
            'adaptedNetlist': body, 'notes': notes,
        }

    result: dict[str, object] = {
        'installed': True,
        'engine': 'lcapy (SymPy-backed symbolic analysis)',
        'node': out_node,
        'source': src,
    }
    if notes:
        result['notes'] = notes
    try:
        vs = cct[src].V(s)
        h = (vout / vs).simplify()
        result['H'] = str(h.expr)
        result['Hlatex'] = h.latex()
        try:
            poles = h.poles()
            result['poles'] = {str(k): int(v) for k, v in poles.expr.items()}
        except Exception as exc:  # poles are best-effort
            result['poles'] = {'error': str(exc)}
        try:
            zeros = h.zeros()
            result['zeros'] = {str(k): int(v) for k, v in zeros.expr.items()}
        except Exception as exc:
            result['zeros'] = {'error': str(exc)}
    except Exception as exc:
        result['H'] = {'error': f'could not form transfer function: {exc}'}
    try:
        vt = cct[out_node].V(t)
        result['Vt'] = str(vt.expr)
        result['VtLatex'] = vt.latex()
    except Exception as exc:
        result['Vt'] = {'error': f'could not derive V(t): {exc}'}
    return result


# ── diagram.json — breadboard wiring around the MCU (P3.3) ───────────────

# Wokwi-compatible part types the harness knows how to reason about
# (pin names for wiring checks). Anything else passes with an "unknown
# part type" note — the schema stays open for community parts.
_DIAGRAM_PART_PINS: dict[str, list[str]] = {
    'wokwi-arduino-uno': [
        'GND.1', 'GND.2', 'GND.3', '5V', '3V3', 'VIN', 'AREF', 'A0', 'A1',
        'A2', 'A3', 'A4', 'A5', '0', '1', '2', '3', '4', '5', '6', '7',
        '8', '9', '10', '11', '12', '13', 'RESET', 'IOREF', 'A4/SDA',
        'A5/SCL',
    ],
    'wokwi-led': ['A', 'C'],
    'wokwi-resistor': ['1', '2'],
    'wokwi-pushbutton': ['1.l', '1.r', '2.l', '2.r'],
    'wokwi-buzzer': ['1', '2'],
    'wokwi-servo': ['GND', 'V+', 'PWM'],
    'wokwi-lcd1602': ['GND', 'VCC', 'SDA', 'SCL'],
    'wokwi-7segment': ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP', 'COM.1', 'COM.2'],
    'wokwi-board-neopixel': ['VCC', 'GND', 'DIN'],
    'wokwi-potentiometer': ['GND', 'SIG', 'VCC'],
    'wokwi-photoresistor': ['1', '2'],
}

# Wire-routing ops in the connection 4th element (v/h/* mini-language).
_WIRE_OPS = frozenset({'v', 'h', '*'})


def _lint_diagram_json(diagram: object) -> tuple[list[str], list[str]]:
    """Validate a wiring diagram → (errors, notes).

    Checks: top-level shape, part ids unique + referenced types known,
    every connection endpoint "<part>:<pin>" resolves to a declared
    part, wire-route ops use the v/h/* vocabulary, and power rails
    (GND/5V/3V3) appear somewhere when an MCU part is present.
    """
    errors: list[str] = []
    notes: list[str] = []
    if not isinstance(diagram, dict):
        return (['diagram must be a JSON object'], notes)
    parts = diagram.get('parts')
    if not isinstance(parts, list) or not parts:
        return (['diagram.parts must be a non-empty array'], notes)

    by_id: dict[str, dict[str, object]] = {}
    has_mcu = False
    for i, part in enumerate(parts):
        if not isinstance(part, dict):
            errors.append(f'parts[{i}] is not an object')
            continue
        pid = str(part.get('id', '')).strip()
        ptype = str(part.get('type', '')).strip()
        if not pid:
            errors.append(f'parts[{i}] is missing id')
            continue
        if pid in by_id:
            errors.append(f'duplicate part id "{pid}"')
            continue
        if not ptype:
            errors.append(f'part "{pid}" is missing type')
            continue
        if not re.match(r'^[A-Za-z][\w.\-/]*$', pid):
            errors.append(f'part id "{pid}" has invalid characters')
        known_pins = _DIAGRAM_PART_PINS.get(ptype)
        if known_pins is None:
            notes.append(
                f'part "{pid}" type "{ptype}" is not in the known-parts '
                'table — pin wiring to it is not checked'
            )
        elif ptype.startswith('wokwi-arduino') or ptype.startswith('wokwi-esp32') or ptype.startswith('wokwi-pi'):
            has_mcu = True
        by_id[pid] = part

    conns = diagram.get('connections', [])
    if not isinstance(conns, list):
        errors.append('connections must be an array')
        conns = []
    rails: set[str] = set()
    for i, conn in enumerate(conns):
        if not isinstance(conn, (list, tuple)) or len(conn) < 2:
            errors.append(f'connections[{i}] must be ["part:pin", "part:pin", ...]')
            continue
        for endpoint in conn[:2]:
            ep = str(endpoint)
            m = re.match(r'^([\w.\-/]+):([A-Za-z0-9_./]+)$', ep)
            if not m:
                errors.append(
                    f'connections[{i}] endpoint "{ep}" is not "part:pin"'
                )
                continue
            pid, pin = m.group(1), m.group(2)
            part = by_id.get(pid)
            if part is None:
                errors.append(
                    f'connections[{i}] references unknown part "{pid}"'
                )
                continue
            known = _DIAGRAM_PART_PINS.get(str(part.get('type', '')))
            if known is not None and pin not in known and not pin.startswith('GND'):
                errors.append(
                    f'part "{pid}" ({part.get("type")}) has no pin "{pin}"'
                )
            if pin.upper().startswith(('GND', 'VCC', '5V', '3V3')):
                rails.add(pin.upper().split('.')[0])
        # Wire-routing mini-language in element [3] (list of ops).
        if len(conn) >= 4 and isinstance(conn[3], list):
            for op in conn[3]:
                tok = str(op)
                base = re.match(r'^([vh*])(-?\d+)?$', tok)
                if base is None:
                    errors.append(
                        f'connections[{i}] wire op "{tok}" is not in the '
                        'v/h/* routing language (e.g. "v10", "h-32", "*")'
                    )

    if has_mcu and 'GND' not in rails:
        notes.append(
            'an MCU part is present but no GND connection is declared — '
            'breadboard grounds are usually implied, confirm the wiring'
        )
    version = diagram.get('version')
    if version not in (None, 1, '1'):
        notes.append(f'diagram version {version!r} is untested; expected 1')
    return (errors, notes)


def circuit_lint_diagram(diagram: object) -> dict[str, object]:
    """Lint a breadboard wiring diagram (diagram.json, Wokwi-compatible).

    Input is the parsed diagram object (or a JSON string). Checks part
    ids/types, that every connection endpoint resolves to a declared
    part pin, the v/h/* wire-routing ops, and power-rail presence around
    an MCU. Netlists remain the SPICE source of truth; the diagram
    describes the breadboard wiring around the MCU (LED → pin 13 etc.)
    and pins the co-sim mapping (which Arduino pin drives which deck
    node).
    """
    if isinstance(diagram, str):
        try:
            diagram = json.loads(diagram)
        except ValueError as exc:
            return {'ok': False, 'errors': [f'diagram is not valid JSON: {exc}']}
    errors, notes = _lint_diagram_json(diagram)
    return {
        'ok': not errors,
        'errors': errors,
        'notes': notes,
        'partCount': len(diagram.get('parts', [])) if isinstance(diagram, dict) else 0,
        'connectionCount': (
            len(diagram.get('connections', [])) if isinstance(diagram, dict) else 0
        ),
    }


# ── Operating-point overlay (voltage-colored schematic, Falstad-style) ────

_ELEMENT_LINE_RE = re.compile(r'^([A-Za-z])(\w*)\s+(.+)$')

# Component letter → human category for the diagram legend.
_ELEMENT_KINDS = {
    'R': 'resistor', 'C': 'capacitor', 'L': 'inductor', 'V': 'source',
    'I': 'isource', 'D': 'diode', 'Q': 'transistor', 'M': 'mosfet',
    'X': 'subckt', 'S': 'switch', 'W': 'cswitch', 'K': 'coupled',
}


@dataclass
class _DeckElement:
    """One element line of a deck, as drawn on the overlay."""

    ref: str
    nodes: list[str]
    value: str
    kind: str


def _parse_components(deck_text: str) -> list[_DeckElement]:
    """Extract (ref, nodes, value) per element line from the deck.

    Skips comments, dot-cards, .control blocks and continuation lines —
    the same rules lint_netlist applies. The value token is the first
    token after the nodes that parses as a SPICE number/param expr; it is
    purely cosmetic (shown on the diagram), not used for math.
    """
    out: list[_DeckElement] = []
    in_control = False
    for ln in deck_text.splitlines():
        s = ln.strip()
        low = s.lower()
        if low.startswith('.control'):
            in_control = True
            continue
        if low.startswith('.endc'):
            in_control = False
            continue
        if in_control or not s or s.startswith(('*', '+', '.')):
            continue
        m = _ELEMENT_LINE_RE.match(s)
        if not m:
            continue
        letter, ref_suffix, rest = m.groups()
        toks = rest.split()
        if len(toks) < 2:
            continue
        kind = _ELEMENT_KINDS.get(letter.upper(), 'part')
        node_count = 4 if kind == 'transistor' else 2
        nodes = [t.strip('[]') for t in toks[:node_count]]
        value = ''
        for t in toks[node_count:]:
            if re.match(r'^[+-]?[\d.]+[A-Za-z]*', t) or t.startswith('{'):
                value = t
                break
        out.append(
            _DeckElement(
                ref=letter.upper() + ref_suffix, nodes=nodes, value=value, kind=kind
            )
        )
    return out


def _voltage_color(v: float, vmin: float, vmax: float) -> str:
    """Map a node voltage onto the cold blue → hot red Falstad ramp."""
    span = (vmax - vmin) or 1.0
    frac = max(0.0, min(1.0, (v - vmin) / span))
    # blue(0.66) → red(0.0) through the low-saturation middle
    hue = 0.66 * (1.0 - frac)
    r, g_, b = colorsys.hsv_to_rgb(hue, 0.72, 0.92)
    return f'#{int(r * 255):02x}{int(g_ * 255):02x}{int(b * 255):02x}'


def _svg_overlay(
    components: list[_DeckElement],
    voltages: dict[str, float],
    currents: dict[str, float],
    title: str,
) -> str:
    """Lay components on a vertical bus stack and emit an SVG document.

    Layout: ground node at the bottom rail; every distinct non-ground
    node gets its own horizontal bus line; each 2-terminal element is a
    vertical rung between its two node lines. Node dots are colored by
    operating-point voltage (blue→red), annotated with the value; each
    rung carries its branch current when known.
    """
    node_order: list[str] = []
    for c in components:
        for n in c.nodes:
            if n not in node_order and n != '0':
                node_order.append(n)
    node_y = {n: 40 + i * 70 for i, n in enumerate(node_order)}
    height = 40 + max(len(node_order), 1) * 70 + 70
    width = 760

    volts = {n: voltages.get(n, float('nan')) for n in node_order}
    known = [v for v in volts.values() if v == v]
    vmin, vmax = (min(known), max(known)) if known else (0.0, 1.0)
    if vmax - vmin < 1e-9:
        vmax = vmin + 1.0

    def esc(t: object) -> str:
        return (
            str(t)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;')
        )
    # ngspice prints branch currents lowercase (v1#branch) while deck refs
    # keep their case (V1) — match refs case-insensitively.
    cur_ci = {k.lower(): v for k, v in currents.items()}
    parts: list[str] = []
    parts.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'font-family="Segoe UI, system-ui, sans-serif">'
    )
    parts.append(f'<text x="16" y="24" font-size="15" font-weight="600">{esc(title)}</text>')

    # Ground rail
    parts.append(
        f'<line x1="60" y1="{height - 46}" x2="{width - 40}" '
        f'y2="{height - 46}" stroke="#94a3b8" stroke-width="2"/>'
    )
    parts.append(
        f'<text x="60" y="{height - 30}" font-size="11" fill="#64748b">0 (gnd) · 0 V</text>'
    )
    parts.append(
        f'<path d="M {width // 2 - 14} {height - 44} l 28 0" stroke="#94a3b8" '
        f'stroke-width="2" fill="none" transform="translate(0,10)"/>'
    )

    # Node buses with voltage-colored dots + labels
    for n in node_order:
        y = node_y[n]
        v = volts[n]
        color = _voltage_color(v, vmin, vmax) if v == v else '#94a3b8'
        parts.append(
            f'<line x1="60" y1="{y}" x2="{width - 40}" y2="{y}" '
            f'stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="none"/>'
        )
        label = f'{n} · {v:.3g} V' if v == v else f'{n} · ?'
        parts.append(f'<circle cx="56" cy="{y}" r="6" fill="{color}" stroke="#334155"/>')
        parts.append(
            f'<text x="16" y="{y + 4}" font-size="11" fill="#334155">{esc(label)}</text>'
        )

    # Element rungs: vertical branch between its node bus lines
    x = 120
    for c in components:
        if len(c.nodes) < 2:
            continue
        top, bottom = c.nodes[0], c.nodes[1]
        y1 = node_y.get(top, None) if top != '0' else height - 46
        y2 = node_y.get(bottom, None) if bottom != '0' else height - 46
        if y1 is None or y2 is None or y1 == y2:
            x += 62
            continue
        parts.append(
            f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" stroke="#475569" stroke-width="2.5"/>'
        )
        mid = (y1 + y2) / 2
        parts.append(
            f'<circle cx="{x}" cy="{mid}" r="4" fill="#475569"/>'
        )
        text = f'{c.ref} {c.value}'.strip()
        cur = cur_ci.get(c.ref.lower())
        cur_txt = f' · {cur:.3g} A' if isinstance(cur, float) else ''
        parts.append(
            f'<text x="{x + 8}" y="{mid - 2}" font-size="11" fill="#0f172a">{esc(text)}</text>'
        )
        if cur_txt:
            parts.append(
                f'<text x="{x + 8}" y="{mid + 12}" font-size="11" fill="#b91c1c">{esc(cur_txt.strip())}</text>'
            )
        x += 62
        if x > width - 90:
            x = 120

    # Color legend
    ly = height - 12
    for i, frac in enumerate((0.0, 0.25, 0.5, 0.75, 1.0)):
        swatch = _voltage_color(vmin + frac * (vmax - vmin), vmin, vmax)
        parts.append(f'<circle cx="{60 + i * 110}" cy="{ly}" r="5" fill="{swatch}"/>')
        parts.append(
            f'<text x="{70 + i * 110}" y="{ly + 4}" font-size="10" fill="#64748b">'
            f'{vmin + frac * (vmax - vmin):.3g} V</text>'
        )
    parts.append('</svg>')
    return '\n'.join(parts)


async def circuit_annotate(
    netlist: str,
    name: str = 'op',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Operating-point overlay: simulate .op and draw a voltage-colored SVG.

    Runs the operating point on the deck (the same convergence ladder and
    invocation modes as circuit_simulate), then renders an SVG diagram with
    every node colored by its DC voltage (blue = low, red = high — the
    Falstad convention) and branch currents annotated on each element.
    The file lands in the workspace as ``<name>.op.svg`` and shows up in
    the right-drawer Circuit panel like any artifact.
    """
    ws = workspace or _workspace(session)
    exe = resolve_ngspice()
    if exe is None:
        return {'installed': False, 'error': _NGSPICE_INSTALL_HINT}

    stripped = (netlist or '').strip()
    source_is_file = False
    if stripped and '\n' not in stripped and len(stripped) < 260:
        candidate = _bind(stripped, ws, for_write=False)
        if candidate.exists():
            source_is_file = True
            deck_text = candidate.read_text(encoding='utf-8', errors='replace')
        else:
            deck_text = stripped
    else:
        deck_text = stripped
    if not deck_text:
        raise ValueError('netlist is empty.')
    if not re.search(r'^\.end\s*$', deck_text, re.M | re.I):
        deck_text += '\n.end'

    # Force an .op analysis: strip other analysis cards so print all
    # reports the operating point whichever card the deck carried.
    op_deck_lines: list[str] = []
    in_control = False
    for ln in deck_text.splitlines():
        low = ln.strip().lower()
        if low.startswith('.control'):
            in_control = True
            continue
        if low.startswith('.endc'):
            in_control = False
            continue
        if in_control:
            continue
        if re.match(r'^\.(tran|ac|dc|sp|noise|pz|four|tf|sens)\b', low):
            continue
        op_deck_lines.append(ln)
    op_deck = '\n'.join(op_deck_lines).rstrip()
    if not re.search(r'^\.op\b', op_deck, re.M | re.I):
        op_deck += '\n.op'
    if not re.search(r'^\.end\s*$', op_deck, re.M | re.I):
        op_deck += '\n.end'

    tmpdir = tempfile.mkdtemp(prefix='aug_circuit_')
    try:
        import asyncio

        async def _feed(args: list[str], stdin_data: bytes | None) -> tuple[int | None, str]:
            proc = await asyncio.create_subprocess_exec(
                exe, *args,
                stdin=asyncio.subprocess.PIPE if stdin_data is not None else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=tmpdir,
            )
            try:
                out_b, _ = await asyncio.wait_for(
                    proc.communicate(input=stdin_data), timeout=60,
                )
            except asyncio.TimeoutError:
                proc.kill()
                return None, '(timeout after 60s)'
            return proc.returncode, out_b.decode('utf-8', errors='replace')

        mode = _NGSPICE_MODE_CACHE.get(exe, 'batch')
        log = ''
        if mode == 'batch':
            deck = Path(tmpdir) / 'op.cir'
            deck.write_text(_server_print_block(op_deck), encoding='utf-8')
            rc, out = await _feed(['-b', str(deck)], None)
            log = out
            if _TMPFILE_FAIL_RE.search(log):
                _NGSPICE_MODE_CACHE[exe] = 'server'
                mode = 'server'
            else:
                _ = rc
        if mode == 'server':
            rc, log = await _feed(
                ['-s'], _server_print_block(op_deck).encode('utf-8')
            )
            _ = rc

        # Parse node voltages + branch currents from print-all output.
        measures: dict[str, float] = {}
        for line in log.splitlines():
            m = _MEASURE_RE.match(line)
            if m:
                try:
                    measures[m.group(1)] = float(m.group(2))
                except ValueError:
                    pass
        _alias_op_measures(measures, op_deck)
        voltages: dict[str, float] = {}
        currents: dict[str, float] = {}
        for k, v in measures.items():
            mk = re.match(r'^v\(([^)]+)\)$', k, re.I)
            mi = re.match(r'^i\(([^)]+)\)$', k, re.I)
            if mk:
                voltages[mk.group(1).strip()] = v
            elif mi:
                currents[mi.group(1).strip()] = v
        if not voltages:
            return {
                'installed': True,
                'error': 'no operating-point node voltages in ngspice output '
                         '(deck failed to converge?)',
                'logTail': '\n'.join(log.splitlines()[-30:]),
            }

        components = _parse_components(deck_text)
        title = f'Operating point — {name}'
        svg = _svg_overlay(components, voltages, currents, title)

        base = str(name)
        if not base.endswith('.op.svg'):
            base = re.sub(r'\.(cir|net|ckt|sp|op\.svg)?$', '', base) + '.op.svg'
        out_path = _bind(base, ws, for_write=True)
        out_path.write_text(svg, encoding='utf-8')
        return {
            'installed': True,
            'savedTo': str(out_path),
            'path': str(out_path),
            'sourceIsFile': source_is_file,
            'nodeVoltages': {k: round(v, 6) for k, v in sorted(voltages.items())},
            'branchCurrents': {
                k: round(v, 9) for k, v in sorted(currents.items())
            },
            'svgBytes': len(svg.encode('utf-8')),
            'converged': True,
        }
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)



# edisplay table rows: "    in                  : d    ,     6"
_EDISPLAY_RE = re.compile(r'^\s+(\S+)\s*:\s*([A-Za-z]+)\s*,\s*(\d+)\s*$')

_VCD_TIME_UNITS = {
    'fs': 1e-15, 'ps': 1e-12, 'ns': 1e-9, 'us': 1e-6, 'ms': 1e-3, 's': 1.0,
}


def _parse_edisplay(log: str) -> list[str]:
    """Event-node names from an ``edisplay`` dump (all digital/UDN nodes)."""
    nodes: list[str] = []
    for line in log.splitlines():
        m = _EDISPLAY_RE.match(line)
        if m and m.group(2).lower() != 'type':
            nodes.append(m.group(1))
    return nodes


def _parse_vcd_summary(text: str) -> dict[str, object]:
    """Header signals, timescale, duration, and change count from VCD text."""
    signals: list[str] = []
    m = re.search(r'\$timescale\s*(\d+)\s*(fs|ps|ns|us|ms|s)\s*\$end', text)
    scale = _VCD_TIME_UNITS[m.group(2)] * float(m.group(1)) if m else None
    last_ts = 0
    changes = 0
    for line in text.splitlines():
        s = line.strip()
        if s.startswith('$var'):
            parts = s.split()
            # $var wire 1 ! dout $end — name sits at index 4, after the
            # width and id symbol.
            if len(parts) >= 5:
                signals.append(parts[4])
        elif s.startswith('#'):
            try:
                last_ts = max(last_ts, int(s[1:]))
            except ValueError:
                continue
        elif s and s[0] in '01xXzZbB' and not s.startswith('$'):
            changes += 1
    summary: dict[str, object] = {
        'signalCount': len(signals),
        'vcdSignals': signals,
        'valueChanges': changes,
    }
    if scale is not None:
        summary['timescale'] = (
            f'{m.group(1)} {m.group(2)}' if m else ''
        )
        summary['duration'] = last_ts * scale
    return summary


async def circuit_export_vcd(
    netlist: str,
    signals: object | None = None,
    name: str = 'digital',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Export digital-node waveforms from a ``.tran`` deck as a VCD file.

    Wraps ngspice's ``eprvcd``: the deck runs once, the named event
    (digital) nodes are dumped in VCD format, and the file is persisted
    into the workspace for waveform viewers and ``vcd_parse``. When
    ``signals`` is omitted, a discovery run lists every event node via
    ``edisplay`` and exports them all. Analog nodes/expressions may be
    included in ``signals`` — they are sampled at event times.
    """
    ws = workspace or _workspace(session)
    exe = resolve_ngspice()
    if exe is None:
        return {'installed': False, 'error': _NGSPICE_INSTALL_HINT}

    source_is_file = False
    stripped = (netlist or '').strip()
    if stripped and '\n' not in stripped and len(stripped) < 260:
        candidate = _bind(stripped, ws, for_write=False)
        if candidate.exists():
            source_is_file = True
            stripped = candidate.read_text(encoding='utf-8', errors='replace').strip()
    deck_text = stripped
    if not deck_text:
        return {'error': 'netlist is empty.'}
    if not deck_text.lstrip().lower().startswith('*'):
        deck_text = f'* vcd export deck\n{deck_text}'
    if not re.search(r'^\.end\s*$', deck_text, re.M | re.I):
        deck_text += '\n.end'
    if not re.search(r'^\.tran\b', deck_text, re.M | re.I):
        return {
            'error': 'VCD export needs a .tran analysis — add a .tran card first.',
        }

    sig_list: list[str] = []
    if signals is not None:
        if isinstance(signals, str):
            sig_list = [s for s in re.split(r'[,\s]+', signals) if s]
        elif isinstance(signals, (list, tuple)):
            sig_list = [str(s).strip() for s in signals if str(s).strip()]

    tmpdir = tempfile.mkdtemp(prefix='aug_vcd_')
    try:
        import asyncio

        async def _spawn(
            args: list[str], stdin_data: bytes | None,
        ) -> tuple[int | None, str]:
            proc = await asyncio.create_subprocess_exec(
                exe,
                *args,
                stdin=asyncio.subprocess.PIPE if stdin_data is not None else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=tmpdir,
            )
            try:
                stdout_b, _ = await asyncio.wait_for(
                    proc.communicate(input=stdin_data), timeout=60,
                )
            except asyncio.TimeoutError:
                proc.kill()
                return None, '(timeout after 60s)'
            return proc.returncode, stdout_b.decode('utf-8', errors='replace')

        async def _run(deck_body: str) -> tuple[int | None, str]:
            """Batch if healthy, server-mode fallback — same rules as
            simulate_circuit's mode cache."""
            mode = _NGSPICE_MODE_CACHE.get(exe, 'batch')
            if mode == 'batch':
                deck = Path(tmpdir) / 'deck.cir'
                deck.write_text(deck_body, encoding='utf-8')
                out_txt = Path(tmpdir) / 'out.txt'
                if out_txt.exists():
                    out_txt.unlink()
                rc, out = await _spawn(['-b', '-o', str(out_txt), str(deck)], None)
                log = ''
                if out_txt.exists():
                    log = out_txt.read_text(encoding='utf-8', errors='replace')
                if not log:
                    log = out
                if _TMPFILE_FAIL_RE.search(log):
                    _NGSPICE_MODE_CACHE[exe] = 'server'
                else:
                    return rc, log
            server_deck = _server_print_block(deck_body)
            return await _spawn(['-s'], server_deck.encode('utf-8'))

        # Discovery pass: no signals requested → list event nodes.
        if not sig_list:
            rc, log = await _run(_with_trace_block(deck_text, ['edisplay']))
            sig_list = _parse_edisplay(log)
            if not sig_list:
                return {
                    'error': (
                        'No event (digital) nodes found — VCD export needs '
                        'XSPICE A-devices (74xx cards, NE555 macro, '
                        'adc_bridge…). Run circuit_env to check XSPICE '
                        'health.'
                    ),
                    'exitCode': rc,
                    'logTail': '\n'.join(log.splitlines()[-20:]),
                }

        vcd_name = 'export.vcd'
        export_line = f"eprvcd {' '.join(sig_list)} > {vcd_name}"
        rc, log = await _run(_with_trace_block(deck_text, [export_line]))
        vcd_tmp = Path(tmpdir) / vcd_name
        if not vcd_tmp.exists() or vcd_tmp.stat().st_size == 0:
            return {
                'error': (
                    'eprvcd produced no VCD output — check that the signals '
                    'are event (digital) nodes of this deck.'
                ),
                'signals': sig_list,
                'exitCode': rc,
                'logTail': '\n'.join(log.splitlines()[-20:]),
            }
        vcd_text = vcd_tmp.read_text(encoding='utf-8', errors='replace')
        result: dict[str, object] = {
            'installed': True,
            'engine': 'ngspice eprvcd',
            'sourceIsFile': source_is_file,
            'signals': sig_list,
            'exitCode': rc,
            **_parse_vcd_summary(vcd_text),
            'bytes': len(vcd_text.encode('utf-8')),
        }
        if ws:
            base = str(name)
            base = base[: -len('.cir')] if base.endswith('.cir') else base
            keep = _bind(f'{base}.vcd', ws, for_write=True)
            keep.write_text(vcd_text, encoding='utf-8')
            result['vcdFile'] = str(keep)
        else:
            result['note'] = 'No workspace — VCD parsed but not persisted.'
            result['vcdPreview'] = '\n'.join(vcd_text.splitlines()[:40])
        return result
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ── Board / MCU brain (Arduino · ESP · Raspberry Pi · more) ──────────────

# Offline knowledge base: every board family the harness is asked about.
# Values are datasheet-derived; web links are attached at query time.
_BOARDS: dict[str, dict[str, str]] = {
    # ── Arduino family ──
    'arduino uno r3': {'mcu': 'ATmega328P', 'logic': '5V', 'flash': '32KB', 'sram': '2KB',
                       'clock': '16MHz', 'pins': '14 DIO · 6 AI', 'usb': 'USB-B', 'note': 'classic AVR'},
    'arduino uno r4': {'mcu': 'Renesas RA4M1 (minima) / ESP32-S3 (wifi)', 'logic': '5V', 'flash': '256KB',
                       'clock': '48MHz', 'note': 'R4 = 32-bit ARM upgrade of UNO'},
    'arduino nano': {'mcu': 'ATmega328P', 'logic': '5V', 'flash': '32KB', 'sram': '2KB',
                     'clock': '16MHz', 'form': 'breadboard', 'note': 'mini-USB'},
    'arduino mega 2560': {'mcu': 'ATmega2560', 'logic': '5V', 'flash': '256KB', 'sram': '8KB',
                          'pins': '54 DIO · 16 AI', 'clock': '16MHz', 'note': 'big AVR'},
    'arduino due': {'mcu': 'ATSAM3X8E Cortex-M3', 'logic': '3.3V', 'flash': '512KB', 'clock': '84MHz',
                    'note': 'first ARM Arduino — NOT 5V tolerant'},
    'arduino leonardo': {'mcu': 'ATmega32U4', 'logic': '5V', 'flash': '32KB', 'clock': '16MHz',
                         'note': 'native USB HID — keyboard/mouse emulation'},
    'arduino micro': {'mcu': 'ATmega32U4', 'logic': '5V', 'form': 'breadboard', 'note': 'leonardo sibling'},
    'arduino pro micro': {'mcu': 'ATmega32U4', 'logic': '5V or 3.3V', 'form': 'breadboard',
                          'note': 'HID clone favorite'},
    'arduino zero': {'mcu': 'SAMD21 Cortex-M0+', 'logic': '3.3V', 'flash': '256KB', 'clock': '48MHz',
                     'note': 'debug port on board'},
    'arduino mkr wifi 1010': {'mcu': 'SAMD21 + NINA-W102', 'logic': '3.3V', 'radio': 'WiFi/BLE',
                              'note': 'MKR family carrier'},
    'arduino portenta h7': {'mcu': 'STM32H747 dual Cortex-M7+M7', 'logic': '3.3V', 'clock': '480MHz',
                            'note': 'pro flagship, graphics-capable'},
    'arduino giga r1': {'mcu': 'STM32H747', 'logic': '3.3V', 'clock': '480MHz', 'note': 'Mega form factor, display headers'},
    'lilygo t-display': {'mcu': 'ESP32', 'display': 'ST7789 1.14in IPS', 'logic': '3.3V', 'note': 'esp32 with screen'},
    # ── ESP family (Espressif) ──
    'esp8266': {'mcu': 'Tensilica L106 80/160MHz', 'logic': '3.3V', 'flash': 'up to 16MB SPI',
                'sram': '~160KB avail', 'radio': 'WiFi b/g/n', 'gpio': '11 usable', 'adc': '1× 10-bit',
                'note': 'no BLE; single ADC'},
    'esp32': {'mcu': 'Xtensa LX6 dual @240MHz', 'logic': '3.3V', 'sram': '520KB', 'flash': '4–16MB',
              'radio': 'WiFi + BT4.2/BLE', 'gpio': '34', 'adc': '18× 12-bit', 'dac': '2× 8-bit',
              'touch': '10 pins', 'note': 'the workhorse'},
    'esp32-s2': {'mcu': 'Xtensa LX7 single @240MHz', 'logic': '3.3V', 'radio': 'WiFi only',
                 'usb': 'native OTG', 'note': 'no BLE; USB HID capable'},
    'esp32-s3': {'mcu': 'Xtensa LX7 dual @240MHz', 'logic': '3.3V', 'radio': 'WiFi + BLE 5',
                 'ai_accel': 'vector instructions', 'usb': 'native OTG', 'note': 'camera/audio ML choice'},
    'esp32-c3': {'mcu': 'RISC-V single @160MHz', 'logic': '3.3V', 'radio': 'WiFi + BLE 5',
                 'note': 'cheap RISC-V drop-in for esp8266'},
    'esp32-c6': {'mcu': 'RISC-V @160MHz', 'logic': '3.3V', 'radio': 'WiFi 6 + BLE 5 + Zigbee/Thread',
                 'note': 'matter-ready'},
    'esp32-h2': {'mcu': 'RISC-V @96MHz', 'logic': '3.3V', 'radio': 'BLE + Zigbee/Thread (no WiFi)',
                 'note': '802.15.4 hub part'},
    # ── Raspberry Pi family ──
    'raspberry pi pico': {'mcu': 'RP2040 dual Cortex-M0+ @133MHz', 'logic': '3.3V', 'sram': '264KB',
                          'flash': '2MB', 'pio': '8 state machines', 'note': 'microcontroller — C/MicroPython'},
    'raspberry pi pico w': {'mcu': 'RP2040 + CYW43439', 'radio': 'WiFi 4 + BLE', 'note': 'pico with radio'},
    'raspberry pi pico 2': {'mcu': 'RP2350 dual Cortex-M33/RISC-V @150MHz', 'logic': '3.3V',
                            'sram': '520KB', 'note': 'secure boot + more SRAM'},
    'raspberry pi 4': {'soc': 'BCM2711 Cortex-A72 ×4 @1.5–1.8GHz', 'ram': '1–8GB', 'logic': '3.3V GPIO',
                       'os': 'Linux (desktop-class)', 'gpio': '40-pin HAT', 'note': 'full computer'},
    'raspberry pi 5': {'soc': 'BCM2712 Cortex-A76 ×4 @2.4GHz', 'ram': '2–16GB', 'pcie': 'yes (nvme)',
                       'note': 'current flagship SBC'},
    'raspberry pi zero 2 w': {'soc': 'RP3A0 quad @1GHz', 'ram': '512MB', 'radio': 'WiFi + BLE',
                              'form': 'pico-sized', 'note': 'tiny Linux + radio'},
    'raspberry pi compute module 4': {'soc': 'BCM2711', 'carrier': 'custom baseboard', 'note': 'embedded product path'},
}


async def list_boards(family: str = '') -> dict[str, object]:
    """List known boards, optionally filtered by family substring."""
    fam = (family or '').strip().lower()
    out: dict[str, dict[str, str]] = {}
    for name, spec in _BOARDS.items():
        if fam and fam not in name:
            continue
        out[name] = spec
    return {'count': len(out), 'boards': out}


def _board_spec(query: str) -> tuple[str, dict[str, str]] | None:
    q = (query or '').strip().lower()
    best: tuple[int, str] | None = None
    for name in _BOARDS:
        if name in q:
            n = len(name)
            if best is None or n > best[0]:
                best = (n, name)
    if best:
        return best[1], _BOARDS[best[1]]
    # token fallback
    for tok in re.split(r'[\s,+/_-]+', q):
        for name in _BOARDS:
            if tok and tok in name:
                return name, _BOARDS[name]
    return None


# Component library additions live here too — MCU boards double as "parts"
# so a schematic can reference an ESP32 symbol and get real pin facts.


async def integrate_component(query: str) -> dict[str, object]:
    """Search → integrate: find a part/board online, then make it usable.

    Pipeline: board brain → offline datasheet library → web datasheet
    hits. When the part maps to a known ngspice model card we emit the
    ready-to-paste SPICE lines so the next netlist can use the part
    immediately. Everything returned is actionable, not just informative.
    """
    q = (query or '').strip()
    if not q:
        return {'error': 'query is required (e.g. "ESP32-S3", "LM7805", "1N4148").'}
    ql = q.lower()

    integrated: dict[str, object] = {}
    # 1) Board brain
    hit = _board_spec(ql)
    if hit:
        name, spec = hit
        integrated['board'] = {'name': name, **spec}

    # 2) Offline part library + ready-to-use SPICE model cards for classics.
    spice_cards = {
        '1n4148': '.model 1N4148 D(IS=2.52n RS=0.588 N=1.752 CJO=4p M=0.4 EG=1.04 XTI=0 BV=100 IBV=100u)',
        '1n4007': '.model 1N4007 D(IS=7.02n RS=0.0341 N=1.8 CJO=18p BV=1000 IBV=5u)',
        '1n4733a': '.model 1N4733A D(BV=5.1 IBV=49m)',
        '1n4728a': '.model 1N4728A D(BV=3.3 IBV=76m)',
        '1n4742a': '.model 1N4742A D(BV=12 IBV=21m)',
        '2n2222': '.model 2N2222 NPN(IS=1e-14 BF=200 VAF=100 RB=10 CJC=8p TF=0.4n)',
        '2n3904': '.model 2N3904 NPN(IS=6.7f BF=300 VAF=100 CJE=4.5p CJC=3.5p TF=0.3n)',
        '2n3906': '.model 2N3906 PNP(IS=1.4f BF=200 VAF=80 CJE=4.5p CJC=7p TF=0.6n)',
        'bc547': '.model BC547 NPN(IS=1.8f BF=290 VAF=80 CJC=6p TF=0.5n)',
        # MOSFETs — level-1 cards, good for switching and DC load work.
        '2n7000': '.model 2N7000 NMOS(VTO=2 KP=0.02 LAMBDA=0.02 RD=0.5 CGS=30p CGD=6p)',
        'bs170': '.model BS170 NMOS(VTO=1.5 KP=0.03 LAMBDA=0.02 RD=0.3 CGS=40p CGD=8p)',
        'irf540': '.model IRF540 NMOS(VTO=3.5 KP=2.0 LAMBDA=0.01 RD=0.02 CGS=1500p CGD=240p)',
        'irf9540': '.model IRF9540 PMOS(VTO=-3.5 KP=1.3 LAMBDA=0.01 RD=0.03 CGS=1300p CGD=220p)',
        # Op-amps — idealized single-pole macros: 100 dB DC gain, one
        # pole for the GBW, 75 Ω output. No rail clamp, no slew limit.
        'tl072': (
            '* TL072 — idealized single-pole macro (GBW 3MHz, no rail clamp)\n'
            '.subckt TL072 INP INM VCC VEE OUT\n'
            'RIN INP INM 2MEG\nG1 6 0 INP INM 1E-3\nR1 6 0 100MEG\nC1 6 0 53P\n'
            'E1 7 0 6 0 1\nROUT 7 OUT 75\n.ends'
        ),
        'op07': (
            '* OP07 — idealized single-pole macro (GBW 0.6MHz, no rail clamp)\n'
            '.subckt OP07 INP INM VCC VEE OUT\n'
            'RIN INP INM 2MEG\nG1 6 0 INP INM 1E-3\nR1 6 0 100MEG\nC1 6 0 265P\n'
            'E1 7 0 6 0 1\nROUT 7 OUT 75\n.ends'
        ),
        'lm324': (
            '* LM324 — idealized single-pole macro (GBW 1MHz, no rail clamp)\n'
            '.subckt LM324 INP INM VCC VEE OUT\n'
            'RIN INP INM 2MEG\nG1 6 0 INP INM 1E-3\nR1 6 0 100MEG\nC1 6 0 159P\n'
            'E1 7 0 6 0 1\nROUT 7 OUT 75\n.ends'
        ),
    }
    lib_hit = None
    for key, spec in _COMPONENT_LIBRARY.items():
        if key in ql or ql in key:
            lib_hit = {'part': key.upper(), **spec}
            if key in spice_cards:
                integrated['spiceModel'] = (
                    f"* {key.upper()} — paste above usage in the deck\n"
                    f"{spice_cards[key]}"
                )
                integrated['usage'] = _usage_example(key)
            elif key == 'ne555':
                _attach_xspice_card(integrated, 'ne555')
            break

    # 2b) 74xx digital logic via XSPICE — gated on the env doctor probe.
    # Family letters normalize away: 74hc00 / 74ls161 → 7400 / 74161.
    qn = _normalize_74xx(ql)
    if lib_hit is None and qn in _XSPICE_COMPONENT_LIBRARY:
        lib_hit = {'part': qn.upper(), **_XSPICE_COMPONENT_LIBRARY[qn]}
        _attach_xspice_card(integrated, qn)

    # 3) Web datasheets — best-effort, offline answers still flow.
    web_hits: list[dict[str, str]] = []

    async def _web() -> list[dict[str, str]]:
        def _fetch() -> list[dict[str, str]]:
            try:
                from ddgs import DDGS

                with DDGS() as ddgs:
                    raw = list(ddgs.text(f'{q} datasheet pdf pinout', max_results=5))
                return [
                    {
                        'title': str(h.get('title') or ''),
                        'url': str(h.get('href') or ''),
                        'snippet': str(h.get('body') or '')[:220],
                    }
                    for h in raw if h.get('href')
                ]
            except Exception as exc:
                logger.debug('integrate_component web search failed', exc_info=exc)
                return []

        return await asyncio.to_thread(_fetch)

    if lib_hit is None or 'board' not in integrated:
        web_hits = await _web()

    result: dict[str, object] = {'query': q, 'integrated': integrated}
    if lib_hit:
        result['library'] = lib_hit
    if web_hits:
        result['datasheets'] = web_hits[:5]
    if not lib_hit and not integrated and not web_hits:
        result['error'] = 'No matches. Try a part number or a board name (e.g. ESP32-C6, LM358).'
    return result

# Curated datasheet facts for the classics — instant, offline, and the
# values the model most often needs (Proteus-style part libraries).
_COMPONENT_LIBRARY: dict[str, dict[str, str]] = {
    '1n4148': {'type': 'signal diode', 'Vf': '0.7V @ 10mA', 'If_max': '200mA continuous', 'trr': '4ns'},
    '1n4007': {'type': 'rectifier diode', 'Vf': '0.7V', 'If_avg': '1A', 'Vrrm': '1000V'},
    '1n4733a': {'type': 'zener 5.1V', 'Vz': '5.1V @ 49mA', 'Pd': '1W'},
    '2n2222': {'type': 'NPN BJT', 'Ic_max': '800mA', 'hFE': '100–300', 'Vceo': '40V', 'ft': '300MHz'},
    '2n3904': {'type': 'NPN BJT', 'Ic_max': '200mA', 'hFE': '100–300', 'Vceo': '40V'},
    '2n3906': {'type': 'PNP BJT', 'Ic_max': '200mA', 'hFE': '100–300', 'Vceo': '40V'},
    'lm7805': {'type': 'linear regulator', 'Vout': '5V', 'Iout_max': '1.5A', 'Vin_range': '7–25V', 'dropout': '2V'},
    'lm7812': {'type': 'linear regulator', 'Vout': '12V', 'Iout_max': '1.5A', 'dropout': '2V'},
    'lm317': {'type': 'adjustable regulator', 'Vout': '1.25–37V', 'Iout_max': '1.5A', 'vref': '1.25V'},
    'lm358': {'type': 'dual op-amp', 'supply': '3–32V single / ±16V dual', 'gbw': '1MHz', 'input_offset': '2mV'},
    'lm741': {'type': 'op-amp', 'supply': '±15V typical', 'gbw': '1MHz', 'slew_rate': '0.5V/µs'},
    'ne555': {'type': 'timer', 'supply': '4.5–16V', 'frequency_range': '0.1Hz–500kHz', 'drive': '200mA'},
    'atmega328p': {'type': 'MCU', 'flash': '32KB', 'sram': '2KB', 'max_clock': '20MHz', 'package': 'DIP-28/TQFP-32'},
    'esp32': {'type': 'MCU (WiFi/BLE)', 'cores': '2× Xtensa LX6 @240MHz', 'sram': '520KB'},
    'bc547': {'type': 'NPN BJT', 'Ic_max': '100mA', 'hFE': '110–800', 'Vceo': '45V'},
    # ── MOSFETs (P1.6) ──
    '2n7000': {'type': 'N-ch MOSFET', 'Vds': '60V', 'Id': '200mA', 'Vgs_th': '0.8–3V', 'Rds_on': '~5Ω @ Vgs=10V'},
    'bs170': {'type': 'N-ch MOSFET', 'Vds': '60V', 'Id': '500mA', 'Vgs_th': '0.8–3V', 'Rds_on': '<5Ω @ Vgs=10V'},
    'irf540': {'type': 'N-ch power MOSFET', 'Vds': '100V', 'Id': '23A', 'Vgs_th': '2–4V', 'Rds_on': '77mΩ @ Vgs=10V'},
    'irf9540': {'type': 'P-ch power MOSFET', 'Vds': '100V', 'Id': '23A', 'Vgs_th': '-2…-4V', 'Rds_on': '117mΩ @ Vgs=-10V'},
    # ── Op-amps (P1.6) ──
    'tl072': {'type': 'dual JFET op-amp', 'supply': '±5–±18V', 'gbw': '3MHz', 'slew_rate': '13V/µs', 'ib': '30pA'},
    'op07': {'type': 'precision op-amp', 'supply': '±3–±22V', 'gbw': '0.6MHz', 'input_offset': '60µV', 'slew_rate': '0.3V/µs'},
    'lm324': {'type': 'quad op-amp', 'supply': '3–32V single / ±16V dual', 'gbw': '1MHz', 'input_offset': '2mV'},
    # ── Regulators (P1.6) ──
    'lm7809': {'type': 'linear regulator', 'Vout': '9V', 'Iout_max': '1.5A', 'dropout': '2V'},
    'lm7833': {'type': 'linear regulator', 'Vout': '3.3V', 'Iout_max': '1.5A', 'dropout': '2V'},
    'lm337': {'type': 'negative adjustable regulator', 'Vout': '-1.25…-37V', 'Iout_max': '1.5A', 'vref': '-1.25V'},
    'lm7905': {'type': 'negative linear regulator', 'Vout': '-5V', 'Iout_max': '1A', 'dropout': '2V'},
    # ── Zeners (P1.6) ──
    '1n4728a': {'type': 'zener 3.3V', 'Vz': '3.3V @ 76mA', 'Pd': '1W'},
    '1n4742a': {'type': 'zener 12V', 'Vz': '12V @ 21mA', 'Pd': '1W'},
}

# 74xx digital logic via ngspice XSPICE code models — advertised only when
# the env doctor's inverter probe says the build ships code models
# (xspice_available() is not False). Keys match after normalizing family
# letters: 74hc00 / 74ls161 / 74hct74 all resolve to their base number.
_XSPICE_COMPONENT_LIBRARY: dict[str, dict[str, str]] = {
    '7400': {'type': 'quad 2-input NAND gate', 'family': '74xx via XSPICE', 'gates': '4', 'pins': '14'},
    '7402': {'type': 'quad 2-input NOR gate', 'family': '74xx via XSPICE', 'gates': '4', 'pins': '14'},
    '7404': {'type': 'hex inverter', 'family': '74xx via XSPICE', 'gates': '6', 'pins': '14'},
    '7408': {'type': 'quad 2-input AND gate', 'family': '74xx via XSPICE', 'gates': '4', 'pins': '14'},
    '7432': {'type': 'quad 2-input OR gate', 'family': '74xx via XSPICE', 'gates': '4', 'pins': '14'},
    '7474': {'type': 'dual D flip-flop', 'family': '74xx via XSPICE', 'note': 'active-low preset/clear modeled'},
    '7476': {'type': 'dual JK flip-flop', 'family': '74xx via XSPICE', 'note': 'active-low preset/clear modeled'},
    '74161': {'type': '4-bit synchronous binary counter', 'family': '74xx via XSPICE',
              'note': 'macro: ENP/ENT count enables + RCO; no parallel load/master clear'},
    '74595': {'type': '8-bit shift register + storage latch', 'family': '74xx via XSPICE',
              'note': 'macro: SER/SRCLK/RCLK + QHS serial out; no shift clear'},
}

_FAMILY_RE = re.compile(r'74(?:hc|hct|ls|als|as|f|s|a)(\d{2,3})')


def _normalize_74xx(q: str) -> str:
    """74hc00 / 74ls161 / 74hct74 → 7400 / 74161 / 7474 (base numbers)."""
    return _FAMILY_RE.sub(r'74\1', q)


# Paste-ready XSPICE subcircuit cards. Port syntax verified against the
# installed ngspice code models (gates: [in...] out arrays; d_dff port
# order data clk set reset out Nout with active-high async set/reset;
# d_pulldown ties unused set/reset ports to digital 0). Power pins are
# omitted — XSPICE logic is ideal 0/1; bridge analog signals with
# adc_bridge/dac_bridge. Every card was simulated end-to-end before
# shipping (see tests/test_circuit_golden.py).
_XSPICE_CARDS: dict[str, str] = {
    '7400': """* 7400 — quad 2-input NAND (XSPICE, ideal logic; power pins omitted)
.model u00_nand d_nand
.subckt 7400 A1 B1 Y1 A2 B2 Y2 A3 B3 Y3 A4 B4 Y4
Ag1 [A1 B1] Y1 u00_nand
Ag2 [A2 B2] Y2 u00_nand
Ag3 [A3 B3] Y3 u00_nand
Ag4 [A4 B4] Y4 u00_nand
.ends
""",
    '7402': """* 7402 — quad 2-input NOR (XSPICE, ideal logic; power pins omitted)
.model u02_nor d_nor
.subckt 7402 A1 B1 Y1 A2 B2 Y2 A3 B3 Y3 A4 B4 Y4
Ag1 [A1 B1] Y1 u02_nor
Ag2 [A2 B2] Y2 u02_nor
Ag3 [A3 B3] Y3 u02_nor
Ag4 [A4 B4] Y4 u02_nor
.ends
""",
    '7404': """* 7404 — hex inverter (XSPICE, ideal logic; power pins omitted)
.model u04_inv d_inverter
.subckt 7404 A1 Y1 A2 Y2 A3 Y3 A4 Y4 A5 Y5 A6 Y6
Ag1 A1 Y1 u04_inv
Ag2 A2 Y2 u04_inv
Ag3 A3 Y3 u04_inv
Ag4 A4 Y4 u04_inv
Ag5 A5 Y5 u04_inv
Ag6 A6 Y6 u04_inv
.ends
""",
    '7408': """* 7408 — quad 2-input AND (XSPICE, ideal logic; power pins omitted)
.model u08_and d_and
.subckt 7408 A1 B1 Y1 A2 B2 Y2 A3 B3 Y3 A4 B4 Y4
Ag1 [A1 B1] Y1 u08_and
Ag2 [A2 B2] Y2 u08_and
Ag3 [A3 B3] Y3 u08_and
Ag4 [A4 B4] Y4 u08_and
.ends
""",
    '7432': """* 7432 — quad 2-input OR (XSPICE, ideal logic; power pins omitted)
.model u32_or d_or
.subckt 7432 A1 B1 Y1 A2 B2 Y2 A3 B3 Y3 A4 B4 Y4
Ag1 [A1 B1] Y1 u32_or
Ag2 [A2 B2] Y2 u32_or
Ag3 [A3 B3] Y3 u32_or
Ag4 [A4 B4] Y4 u32_or
.ends
""",
    '7474': """* 7474 — dual D flip-flop, active-low preset/clear (XSPICE macro)
* d_dff async set/reset are active-high, so PRE/CLR go through inverters.
* Ports: data clk set reset out Nout. Usage: X1 clk d pre clr q nq 7474
.model u74_inv d_inverter
.model u74_dff d_dff(ic=0)
.subckt 7474 CLK1 D1 PRE1 CLR1 Q1 NQ1 CLK2 D2 PRE2 CLR2 Q2 NQ2
Aps1 PRE1 pset1 u74_inv
Acl1 CLR1 prst1 u74_inv
Aff1 D1 CLK1 pset1 prst1 Q1 NQ1 u74_dff
Aps2 PRE2 pset2 u74_inv
Acl2 CLR2 prst2 u74_inv
Aff2 D2 CLK2 pset2 prst2 Q2 NQ2 u74_dff
.ends
""",
    '7476': """* 7476 — dual JK flip-flop, active-low preset/clear (XSPICE macro)
* Ports: j k clk set reset out Nout. Usage: X1 clk j k pre clr q nq 7476
.model u76_inv d_inverter
.model u76_jkff d_jkff(ic=0)
.subckt 7476 CLK1 J1 K1 PRE1 CLR1 Q1 NQ1 CLK2 J2 K2 PRE2 CLR2 Q2 NQ2
Aps1 PRE1 pset1 u76_inv
Acl1 CLR1 prst1 u76_inv
Aff1 J1 K1 CLK1 pset1 prst1 Q1 NQ1 u76_jkff
Aps2 PRE2 pset2 u76_inv
Acl2 CLR2 prst2 u76_inv
Aff2 J2 K2 CLK2 pset2 prst2 Q2 NQ2 u76_jkff
.ends
""",
    '74161': """* 74161 — 4-bit synchronous binary counter (XSPICE macro)
* Pins: CLK ENP ENT Q0 Q1 Q2 Q3 RCO. Count enable = ENP·ENT;
* RCO = Q3·Q2·Q1·Q0·ENT. No parallel load, no master clear.
* Usage: X1 clk enp ent q0 q1 q2 q3 rco 74161 (all digital nodes;
* bridge analog clocks/signals with adc_bridge, outputs with dac_bridge).
.model u161_and d_and
.model u161_xor d_xor
.model u161_dff d_dff(ic=0)
.model u161_pd d_pulldown
.subckt 74161 CLK ENP ENT Q0 Q1 Q2 Q3 RCO
Apd d0lt u161_pd
At0 [ENP ENT] t0 u161_and
Ad0 [Q0 t0] dd0 u161_xor
Aff0 dd0 CLK d0lt d0lt Q0 NQ0 u161_dff
At1 [Q0 t0] t1 u161_and
Ad1 [Q1 t1] dd1 u161_xor
Aff1 dd1 CLK d0lt d0lt Q1 NQ1 u161_dff
At2 [Q0 Q1 t0] t2 u161_and
Ad2 [Q2 t2] dd2 u161_xor
Aff2 dd2 CLK d0lt d0lt Q2 NQ2 u161_dff
At3 [Q0 Q1 Q2 t0] t3 u161_and
Ad3 [Q3 t3] dd3 u161_xor
Aff3 dd3 CLK d0lt d0lt Q3 NQ3 u161_dff
Arc [Q3 t3] RCO u161_and
.ends
""",
    '74595': """* 74595 — 8-bit shift register + storage latch (XSPICE macro)
* Pins: SER SRCLK RCLK Q0..Q7 QHS (QH' serial out). No shift clear.
* Usage: X1 ser srclk rclk q0 q1 q2 q3 q4 q5 q6 q7 qhs 74595
.model u595_dff d_dff(ic=0)
.model u595_pd d_pulldown
.model u595_buf d_buffer
.subckt 74595 SER SRCLK RCLK Q0 Q1 Q2 Q3 Q4 Q5 Q6 Q7 QHS
Apd d0lt u595_pd
As0 SER SRCLK d0lt d0lt s0 s0b u595_dff
As1 s0 SRCLK d0lt d0lt s1 s1b u595_dff
As2 s1 SRCLK d0lt d0lt s2 s2b u595_dff
As3 s2 SRCLK d0lt d0lt s3 s3b u595_dff
As4 s3 SRCLK d0lt d0lt s4 s4b u595_dff
As5 s4 SRCLK d0lt d0lt s5 s5b u595_dff
As6 s5 SRCLK d0lt d0lt s6 s6b u595_dff
As7 s6 SRCLK d0lt d0lt s7 s7b u595_dff
Al0 s0 RCLK d0lt d0lt Q0 Q0b u595_dff
Al1 s1 RCLK d0lt d0lt Q1 Q1b u595_dff
Al2 s2 RCLK d0lt d0lt Q2 Q2b u595_dff
Al3 s3 RCLK d0lt d0lt Q3 Q3b u595_dff
Al4 s4 RCLK d0lt d0lt Q4 Q4b u595_dff
Al5 s5 RCLK d0lt d0lt Q5 Q5b u595_dff
Al6 s6 RCLK d0lt d0lt Q6 Q6b u595_dff
Al7 s7 RCLK d0lt d0lt Q7 Q7b u595_dff
Abuf s7 QHS u595_buf
.ends
""",
    'ne555': """* NE555 — functional macro via XSPICE (adc_bridge comparators, d_srff
* latch, SW discharge transistor). Pins: GND TRIG OUT RESET CTRL THRES
* DISCH VCC. GND must be node 0. Thresholds fixed for a 5 V supply
* (2/3·5V and 1/3·5V); RESET/CTRL accepted but held inactive; OUT swings
* 0..VCC. Ra/Rb/C timing parts stay external, as in a real 555 circuit.
.model u555_sw SW(RON=10 ROFF=1e9 VT=0.5 VH=0.1)
.model u555_phi adc_bridge(in_low=3.3283 in_high=3.3383)
.model u555_lo adc_bridge(in_low=1.6617 in_high=1.6717)
.model u555_pd d_pulldown
.model u555_srff d_srff(ic=0)
.model u555_inv d_inverter
.model u555_qb dac_bridge
.model u555_ob dac_bridge
.subckt NE555 GND TRIG OUT RESET CTRL THRES DISCH VCC
Rreset RESET GND 1MEG
Rctrl CTRL GND 1MEG
Acmp1 [THRES] [thr] u555_phi
Acmp2 [TRIG] [trigd] u555_lo
Apd d0lt u555_pd
Ainv trigd trign u555_inv
Alatch d0lt d0lt d0lt thr trign q nq u555_srff
Adisch [q] [qana] u555_qb
S1 DISCH GND qana GND u555_sw
Aout [nq] [outd] u555_ob
Bout OUT GND V=V(outd)*V(VCC)
.ends
""",
}

# Instantiation lines paired with each XSPICE card (port order must match
# the .subckt header exactly).
_XSPICE_USAGE: dict[str, str] = {
    '7400': 'X1 a1 b1 y1 a2 b2 y2 a3 b3 y3 a4 b4 y4 7400',
    '7402': 'X1 a1 b1 y1 a2 b2 y2 a3 b3 y3 a4 b4 y4 7402',
    '7404': 'X1 a1 y1 a2 y2 a3 y3 a4 y4 a5 y5 a6 y6 7404',
    '7408': 'X1 a1 b1 y1 a2 b2 y2 a3 b3 y3 a4 b4 y4 7408',
    '7432': 'X1 a1 b1 y1 a2 b2 y2 a3 b3 y3 a4 b4 y4 7432',
    '7474': 'X1 clk1 d1 pre1 clr1 q1 nq1 clk2 d2 pre2 clr2 q2 nq2 7474',
    '7476': 'X1 clk1 j1 k1 pre1 clr1 q1 nq1 clk2 j2 k2 pre2 clr2 q2 nq2 7476',
    '74161': 'X1 clk enp ent q0 q1 q2 q3 rco 74161',
    '74595': 'X1 ser srclk rclk q0 q1 q2 q3 q4 q5 q6 q7 qhs 74595',
    'ne555': 'X1 0 trig out reset ctrl thres disch vcc NE555 (GND pin must be node 0)',
}

_XSPICE_BRIDGE_NOTE = (
    ' All pins are digital nodes (0/1): drive them from analog sources '
    'through adc_bridge and read outputs with dac_bridge (0–1 V swing).'
)

_MOSFET_KEYS = frozenset(('2n7000', 'bs170', 'irf540', 'irf9540'))
_OPAMP_KEYS = frozenset(('tl072', 'op07', 'lm324'))


def _usage_example(key: str) -> str:
    part = key.upper()
    if key.startswith('1n'):
        return f'Example: D1 anode cathode {part}'
    if key in _MOSFET_KEYS:
        return f'Example: M1 drain gate source source {part} (bulk tied to source)'
    if key in _OPAMP_KEYS:
        return f'Example: X1 inp inm vcc vee out {part} (macro pins INP INM VCC VEE OUT)'
    return f'Example: Q1 c b e {part}'


def _attach_xspice_card(integrated: dict[str, object], key: str) -> None:
    """Attach the paste-ready XSPICE card for `key` unless the env doctor
    has ruled this build's code models dead (False). Unknown state (None —
    circuit_env not run in this process) still attaches the card, with a
    verify-first note instead of withholding parts that probably exist."""
    state = xspice_available()
    if state is False:
        integrated['xspiceNote'] = (
            'This part needs ngspice XSPICE code models, and the last '
            'circuit_env probe said they are missing from this build — '
            'the card is withheld until the probe passes.'
        )
        return
    card = _XSPICE_CARDS.get(key)
    if not card:
        return
    usage = _XSPICE_USAGE.get(key, '')
    if key != 'ne555':
        usage += _XSPICE_BRIDGE_NOTE
    integrated['spiceModel'] = card
    integrated['usage'] = usage
    integrated['xspiceRequired'] = True
    if state is None:
        integrated['xspiceNote'] = (
            'XSPICE availability not verified yet in this process — run '
            'circuit_env once; if it reports xspice=false this card will '
            'not simulate.'
        )


async def search_component(query: str) -> dict[str, object]:
    """Look up a component: offline library first, then web datasheet hits.

    Async by contract; the network lookup runs on a worker thread so the
    event loop is never blocked by the sync ddgs client.
    """
    q = (query or '').strip().lower()
    if not q:
        return {'error': 'query is required (e.g. "LM7805" or "1n4007").'}
    lib_hit = None
    for key, spec in _COMPONENT_LIBRARY.items():
        if key in q or q in key:
            lib_hit = {'part': key.upper(), **spec}
            break
    if lib_hit is None:
        # 74xx logic lives in the gated XSPICE library; family letters
        # normalize away (74hc00 / 74ls161 → 7400 / 74161).
        qn = _normalize_74xx(q)
        if qn in _XSPICE_COMPONENT_LIBRARY:
            lib_hit = {'part': qn.upper(), **_XSPICE_COMPONENT_LIBRARY[qn]}
            state = xspice_available()
            if state is False:
                lib_hit['xspiceNote'] = (
                    'Needs ngspice XSPICE code models — the last '
                    'circuit_env probe said they are missing from this build.'
                )
            elif state is None:
                lib_hit['xspiceNote'] = (
                    'XSPICE not verified yet — run circuit_env before '
                    'designing with this part.'
                )

    def _web() -> list[dict[str, str]]:
        hits: list[dict[str, str]] = []
        try:
            from ddgs import DDGS

            with DDGS() as ddgs:
                raw = list(ddgs.text(f'{q} datasheet pdf', max_results=5))
            for hit in raw:
                title = str(hit.get('title') or '')
                url = str(hit.get('href') or '')
                body = str(hit.get('body') or '')
                if url:
                    hits.append({'title': title, 'url': url, 'snippet': body[:220]})
        except Exception as exc:  # network optional — library results still flow
            logger.debug('component web search failed', exc_info=exc)
        return hits

    web_hits = await asyncio.to_thread(_web)
    if lib_hit is None and not web_hits:
        return {'query': query, 'error': 'No matches. Try a part number (e.g. NE555).'}
    return {'query': query, 'library': lib_hit, 'datasheets': web_hits}


# ── 3D board view ─────────────────────────────────────────────────────────


def _board_from_netlist(content: str) -> list[dict[str, object]]:
    """Derive simple board placement from netlist components (grid layout)."""
    comps = []
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith(('*', '.', '+')):
            continue
        parts = line.split()
        if len(parts) >= 2:
            comps.append({'ref': parts[0], 'type': parts[0][0].upper()})
    n = max(1, len(comps))
    cols = max(1, int(n**0.5 + 0.999))
    placed = []
    for i, comp in enumerate(comps):
        placed.append({**comp, 'x': float(i % cols), 'y': float(i // cols)})
    return placed


_TYPE_HEIGHT = {'R': 0.08, 'C': 0.12, 'L': 0.18, 'D': 0.08, 'V': 0.3, 'Q': 0.2, 'U': 0.15, 'X': 0.15}
_TYPE_COLOR = {
    'R': '#c9a227', 'C': '#3b82f6', 'L': '#10b981', 'D': '#ef4444',
    'V': '#6b7280', 'Q': '#8b5cf6', 'U': '#0ea5e9', 'X': '#f59e0b',
}


def render_board_3d(
    path: str,
    netlist_or_path: str,
    width: float = 60,
    height: float = 45,
    elevation: float = 28,
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Render a KiCad-style 3D board preview PNG (mplot3d).

    Components are lifted off a green PCB substrate as labeled boxes;
    height/color follow the reference designator (R/C/L/Q/U...), which is
    exactly how KiCad's 3D viewer maps footprints. Accepts inline
    netlist text or a path, mirroring simulate_circuit.
    """
    out = _bind(path, workspace, for_write=True)
    if out.suffix.lower() != '.png':
        raise ValueError(f'{path} must be a .png')
    ws = workspace or _workspace(session)

    content: str
    stripped = (netlist_or_path or '').strip()
    if stripped and '\n' not in stripped and len(stripped) < 260:
        candidate = _bind(stripped, ws, for_write=False)
        if candidate.exists():
            content = candidate.read_text(encoding='utf-8', errors='replace')
        else:
            content = stripped
    else:
        content = stripped
    if not content.strip():
        raise ValueError('netlist_or_path is empty.')
    if not content.lstrip().startswith('*'):
        content = f'* board\n{content}'

    placements = _board_from_netlist(content)

    import matplotlib

    matplotlib.use('Agg', force=True)
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection  # type: ignore[import-untyped]

    fig = plt.figure(figsize=(9, 6), dpi=150)
    ax: Any = fig.add_subplot(111, projection='3d')

    # PCB substrate
    z0 = 0.0
    verts = [
        [(0, 0, z0), (width, 0, z0), (width, height, z0), (0, height, z0)],
    ]
    pcb = Poly3DCollection(verts, facecolors='#166534', edgecolors='#052e16', alpha=0.96)
    ax.add_collection3d(pcb)

    # Component bodies — placements are plain dicts from _board_from_netlist;
    # float() coercion keeps the arithmetic unambiguous for type-checkers.
    body: dict[str, object]
    xs = [float(body['x']) for body in placements] or [0.0]  # type: ignore[arg-type]
    ys = [float(body['y']) for body in placements] or [0.0]  # type: ignore[arg-type]
    span_x = max(1.0, max(xs) + 1)
    span_y = max(1.0, max(ys) + 1)
    for body in placements:
        cx = (float(body['x']) + 0.5) * width / span_x  # type: ignore[arg-type]
        cy = (float(body['y']) + 0.5) * height / span_y  # type: ignore[arg-type]
        h = _TYPE_HEIGHT.get(str(body.get('type')), 0.1) * height / 6
        color = _TYPE_COLOR.get(str(body.get('type')), '#94a3b8')
        bw = width / span_x * 0.55
        bd = height / span_y * 0.55
        # Box as 6 faces
        x0, x1 = cx - bw / 2, cx + bw / 2
        y0, y1 = cy - bd / 2, cy + bd / 2
        faces = [
            [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)],
            [(x0, y0, h), (x1, y0, h), (x1, y1, h), (x0, y1, h)],
            [(x0, y0, z0), (x1, y0, z0), (x1, y0, h), (x0, y0, h)],
            [(x1, y0, z0), (x1, y1, z0), (x1, y1, h), (x1, y0, h)],
            [(x1, y1, z0), (x0, y1, z0), (x0, y1, h), (x1, y1, h)],
            [(x0, y1, z0), (x0, y0, z0), (x0, y0, h), (x0, y1, h)],
        ]
        box = Poly3DCollection(faces, facecolors=color, edgecolors='#111827', alpha=0.95)
        ax.add_collection3d(box)
        ax.text(cx, cy, h + height * 0.02, str(body['ref']), fontsize=6, ha='center')

    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_zlim(0, max(0.5, height * 0.08))
    ax.set_box_aspect((width, height, max(0.5, height * 0.08)))
    ax.view_init(elev=elevation, azim=-60)
    ax.set_axis_off()
    ax.set_title('Board preview — 3D', fontsize=9)
    fig.tight_layout()
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out)
    plt.close(fig)
    return {
        'path': str(out),
        'componentCount': len(placements),
        'refs': [str(p['ref']) for p in placements][:40],
    }
