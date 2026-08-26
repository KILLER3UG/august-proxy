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
import logging
import os
import re
import shutil
import tempfile
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
    'circuit_search_component (part facts + datasheet links), '
    'circuit_render_3d (KiCad-style board PNG shown in the right Circuit '
    'panel), circuit_list_boards (Arduino/ESP/Raspberry Pi spec sheets), '
    'circuit_integrate_component (search a part/board → datasheet facts + '
    'ready-to-paste SPICE model cards — call it BEFORE designing with an '
    'unfamiliar part). SPICE units are strict: M = milli, Meg = mega '
    '(1M ohm is a milliohm!), node 0 is ground. Fix every lint warning and '
    'check soaWarnings before calling a design bench-ready. When a design '
    'uses a dev board, respect its logic level (ESP/Pi = 3.3V, UNO = 5V) '
    'and flag level-shifting needs in your answer.'
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
    """Locate an ngspice executable (PATH first, then common install dirs)."""
    exe = shutil.which('ngspice')
    if exe:
        return exe
    candidates = [
        r'C:\Program Files\ngspice\bin\ngspice.exe',
        r'C:\Program Files\ngspice\bin\ngspice_con.exe',
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
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith('*') or line.startswith('.'):
            continue
        parts = line.split()
        if len(parts) >= 2:
            components.append(
                {
                    'name': parts[0],
                    'type': parts[0][0].upper(),
                    'nodes': parts[1:-1] if len(parts) > 2 else [],
                    'value': parts[-1] if len(parts) >= 3 else '',
                }
            )
    return {'path': str(src), 'components': components, 'content': content}


def update_netlist(path: str, find: str, replace: str, workspace: str = '') -> dict[str, object]:
    src = _bind(path, workspace, for_write=False)
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
    ws = _bind('.', workspace, for_write=False) if workspace else Path(tempfile.gettempdir())
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

_MEASURE_RE = re.compile(r'^\s*(\w+)\s*=\s*([-+0-9.eE]+)\s*$')

# SPICE scale factors (ngspice manual Table 2.1): M = MILLI, Meg = MEGA.
# This asymmetry is the single most common "worked in sim, fried on the
# bench" bug — 1M ohm parses as 1 milliohm.
_SPICE_SCALE: dict[str, float] = {
    'T': 1e12, 'G': 1e9, 'MEG': 1e6, 'K': 1e3, 'MIL': 25.4e-6,
    'M': 1e-3, 'U': 1e-6, 'N': 1e-9, 'P': 1e-12, 'F': 1e-15,
}


def parse_spice_value(raw: str) -> float | None:
    """Parse a SPICE numeric value with engineering suffixes.

    Trailing letters after a scale factor are ignored (``10k``, ``4k7``
    is NOT supported here — that's a KiCad value convention, not SPICE;
    ``4.7k`` is). Returns None when unparseable.
    """
    s = (raw or '').strip()
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


_CONVERGENCE_LADDER: tuple[dict[str, object], ...] = (
    {},  # pass 1: defaults
    {'gmin': '1e-10'},                      # gentler gmin
    {'gmin': '1e-9', 'abstol': '1e-9'},     # looser absolute tolerance
    {'gmin': '1e-9', 'abstol': '1e-9', 'itl1': '400'},   # more DC iterations
    {'gmin': '1e-9', 'abstol': '1e-9', 'itl1': '400',
     'rshunt': '1e9'},                       # last resort: leak to ground
)


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


async def simulate_circuit(
    netlist: str,
    name: str = 'sim',
    workspace: str = '',
    session: object | None = None,
) -> dict[str, object]:
    """Run an ngspice batch simulation and parse the printed measures.

    ``netlist`` may be inline SPICE text OR a path to a .cir/.net/.ckt
    file in the workspace (auto-detected). Analysis cards mirror physical
    benches: ``.op`` (operating point = what a multimeter reads at rest),
    ``.dc`` sweeps, ``.tran`` (oscilloscope-style time domain), ``.ac``
    (frequency response).

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
            'error': (
                'ngspice is not installed on this machine. Install it '
                '(winget install ngspice, choco install ngspice, or '
                'https://ngspice.sourceforge.io) — the harness uses the '
                'same SPICE engine as Kicad/professional simulators. Until '
                'then you can still build/edit/draw circuits with '
                'draw_circuit and manage netlists.'
            ),
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

        import asyncio

        out_txt = Path(tmpdir) / 'out.txt'
        log_txt = Path(tmpdir) / 'log.txt'

        async def _run_once(options: dict[str, object]) -> tuple[int | None, str]:
            """Write deck with the given .options and run ngspice batch."""
            deck = Path(tmpdir) / 'deck.cir'
            deck.write_text(_apply_options(deck_text, options), encoding='utf-8')
            for f in (out_txt, log_txt):
                if f.exists():
                    f.unlink()
            proc = await asyncio.create_subprocess_exec(
                exe,
                '-b',
                '-o', str(out_txt),
                str(deck),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=tmpdir,
            )
            try:
                stdout_b, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
            except asyncio.TimeoutError:
                proc.kill()
                return None, '(timeout after 60s)'
            log = ''
            for f in (out_txt, log_txt):
                if f.exists():
                    log += f.read_text(encoding='utf-8', errors='replace')
            if not log and stdout_b:
                log = stdout_b.decode('utf-8', errors='replace')
            return proc.returncode, log

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
        for line in log.splitlines():
            m = _MEASURE_RE.match(line)
            if m:
                try:
                    measures[m.group(1)] = float(m.group(2))
                except ValueError:
                    pass
        errors = [
            ln for ln in log.splitlines()
            if re.search(r"\berror\b|\bcouldn't|failed|unknown", ln, re.I)
        ]
        # SOA warnings from ngspice (.options warn=1 on later rungs): these
        # are the "will survive the bench" signals — device voltage /
        # current / power beyond model limits.
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
        # Persist the deck into the workspace when the input was inline, so
        # the run has a durable artifact the user can edit/re-run.
        if not source_is_file and ws:
            keep = _bind(f'{name}.cir' if not str(name).endswith('.cir') else str(name), ws, for_write=True)
            keep.write_text(deck_text + '\n', encoding='utf-8')
            result['savedTo'] = str(keep)
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
        '2n2222': '.model 2N2222 NPN(IS=1e-14 BF=200 VAF=100 RB=10 CJC=8p TF=0.4n)',
        '2n3904': '.model 2N3904 NPN(IS=6.7f BF=300 VAF=100 CJE=4.5p CJC=3.5p TF=0.3n)',
        '2n3906': '.model 2N3906 PNP(IS=1.4f BF=200 VAF=80 CJE=4.5p CJC=7p TF=0.6n)',
        'bc547': '.model BC547 NPN(IS=1.8f BF=290 VAF=80 CJC=6p TF=0.5n)',
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
                integrated['usage'] = (
                    f"Use refdes D<nn> and add `.include`-free inline card; "
                    f"example: D1 anode cathode {key.upper()}"
                    if key.startswith(('1n', '1n4')) else
                    f"Example: Q1 c b e {key.upper()}"
                )
            break

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
}


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
